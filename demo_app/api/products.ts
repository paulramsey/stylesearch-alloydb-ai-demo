import { Database, DatabasePsv, camelCaseRows, safeString, SelectedFacets, interpolateQuery } from './database';

// Interface for the raw facet data from SQL
export interface RawFacet {
    facet_value: string;
    facet_type: 'brand' | 'category' | 'price_range'; // Use specific types
    count: number;
}

// Interface for the structured facet response
export interface FacetGroup {
    type: string;
    values: { value: string; count: number }[];
}

// --- Helper Function for Price Range Conditions ---
// Translates facet string values ('$50 - $99.99') into SQL conditions
function buildPriceRangeCondition(priceRanges: string[] | undefined): string {
    if (!priceRanges || priceRanges.length === 0) {
        return ""; // No price condition
    }

    const conditions = priceRanges.map(range => {
        switch (range) {
            case '$0 - $49.99':    return "(p.retail_price >= 0 AND p.retail_price < 50)";
            case '$50 - $99.99':   return "(p.retail_price >= 50 AND p.retail_price < 100)";
            case '$100 - $249.99': return "(p.retail_price >= 100 AND p.retail_price < 250)";
            case '$250 - $499.99': return "(p.retail_price >= 250 AND p.retail_price < 500)";
            case '$500+':          return "(p.retail_price >= 500)";
            default:
                console.warn(`Unknown price range facet value: ${range}`);
                return "FALSE"; // Or handle unknown ranges differently
        }
    });

    // Combine multiple selected ranges with OR
    return `AND (${conditions.join(" OR ")})`;
}

// --- Helper Function for General Facet Conditions ---
function buildFacetCondition(
    paramIndexStart: number,
    facetType: 'brand' | 'category', // Add other types if needed
    values: string[] | undefined,
    sqlColumnName: string // e.g., 'p.brand', 'p.category'
): { clause: string, params: any[], nextParamIndex: number } {

    if (!values || values.length === 0) {
        return { clause: "", params: [], nextParamIndex: paramIndexStart };
    }

    const paramPlaceholder = `$${paramIndexStart}`;
    const clause = `AND ${sqlColumnName} = ANY(${paramPlaceholder})`;
    const params = [values]; // Pass the array of selected values as a single parameter

    return { clause, params, nextParamIndex: paramIndexStart + 1 };
}


// --- Helper Function to build the WHERE clause from selected facets ---
function buildFacetWhereClause(selectedFacets: SelectedFacets): { clause: string, params: any[] } {
    let conditions: string[] = [];
    let queryParams: any[] = [];
    let paramIndex = 1; // Start parameter index at $1

    // Brand
    const brandCondition = buildFacetCondition(paramIndex, 'brand', selectedFacets['brand'], 'p.brand');
    if (brandCondition.clause) {
        conditions.push(brandCondition.clause);
        queryParams.push(...brandCondition.params);
        paramIndex = brandCondition.nextParamIndex;
    }

    // Category
    const categoryCondition = buildFacetCondition(paramIndex, 'category', selectedFacets['category'], 'p.category');
    if (categoryCondition.clause) {
        conditions.push(categoryCondition.clause);
        queryParams.push(...categoryCondition.params);
        paramIndex = categoryCondition.nextParamIndex;
    }

    // Price Range (handled separately as it doesn't use = ANY)
    const priceCondition = buildPriceRangeCondition(selectedFacets['price_range']);
    if (priceCondition) {
        conditions.push(priceCondition);
        // No parameters added for price range as it's built directly into the string
    }

    // Combine all conditions
    const whereClause = conditions.length > 0 ? conditions.join(" ") : "";

    return { clause: whereClause, params: queryParams };
}

// --- Helper Function to build candidate_ids CTE for facet query ---
function buildFacetCandidateSql(searchTerm: string, searchType: string): string {
    const safeSearchTerm = safeString(searchTerm);
    let candidateSql = `
        candidate_ids AS (
    `;

    switch (searchType.toUpperCase()) {
        case 'SEMANTIC':
        case 'TEXT_EMBEDDINGS': // Alias
             candidateSql += `
                SELECT id, embedding <=> embedding('text-embedding-005', '${safeSearchTerm}')::vector AS distance
                FROM products ORDER BY distance LIMIT 500
            ) SELECT id FROM candidate_ids WHERE distance < 0.65 -- Adjust threshold as needed
            `;
            break;
        case 'FULLTEXT':
            candidateSql += `
                SELECT id FROM products WHERE fts_document @@ websearch_to_tsquery('english', '${safeSearchTerm}')
            )
            `;
            break;
         case 'TRADITIONALSQL':
            let formattedSearchTerm = searchTerm.replace(/\s+/g, ' ').split(' ').join('%')
            candidateSql += `
                SELECT id FROM products WHERE name ILIKE '%${safeString(formattedSearchTerm)}%'
                 OR sku ILIKE '%${safeString(formattedSearchTerm)}%'
                 OR category ILIKE '%${safeString(formattedSearchTerm)}%'
                 OR brand ILIKE '%${safeString(formattedSearchTerm)}%'
                 OR department ILIKE '%${safeString(formattedSearchTerm)}%'
                 OR product_description ILIKE '%${safeString(formattedSearchTerm)}%'
            )
            `;
             break;
        case 'HYBRID': 
             candidateSql += `
                WITH vector_candidates AS (
                  SELECT id, embedding <=> embedding('text-embedding-005', '${safeSearchTerm}')::vector AS distance FROM products ORDER BY distance LIMIT 500
                )
                SELECT id FROM vector_candidates WHERE distance < 0.65
                UNION
                SELECT id FROM products WHERE sku = '${safeSearchTerm}'
                UNION
                SELECT id FROM products WHERE fts_document @@ websearch_to_tsquery('english', '${safeSearchTerm}')
            )
            `;
            break;
    }
    return candidateSql;
}

export class Products {
    constructor(private db: Database,
        private dbPsv: DatabasePsv
    ) { }

    async getFacets(searchTerm: string, searchType: string, selectedFacets?: SelectedFacets): Promise<{ data: RawFacet[], query: string, errorDetail?: string }> {
        let queryTemplate;
        const candidateSql = buildFacetCandidateSql(searchTerm, searchType); // Build dynamic CTE based on search term/type

        // Build the WHERE clause and parameters based on the *selected* facets
        const { clause: facetWhereClause, params: facetParams } = buildFacetWhereClause(selectedFacets ?? {});

        try {
            queryTemplate = `
            WITH
              ${candidateSql} -- Candidates based on initial search term/type
              ,
              -- Filter products based on BOTH candidates AND selected facets
              products_for_faceting AS (
                SELECT
                  p.brand,
                  p.category,
                  p.retail_price
                FROM
                  products AS p
                  JOIN candidate_ids AS c ON p.id = c.id
                WHERE 1=1 ${facetWhereClause} -- Apply selected facet filters HERE
              ),
              -- Prepare data with calculated price range AFTER filtering
              products_with_price_range AS (
                 SELECT
                      pff.brand,
                      pff.category,
                      CASE
                        WHEN pff.retail_price < 50 THEN '$0 - $49.99'
                        WHEN pff.retail_price >= 50 AND pff.retail_price < 100 THEN '$50 - $99.99'
                        WHEN pff.retail_price >= 100 AND pff.retail_price < 250 THEN '$100 - $249.99'
                        WHEN pff.retail_price >= 250 AND pff.retail_price < 500 THEN '$250 - $499.99'
                        WHEN pff.retail_price >= 500 THEN '$500+'
                        ELSE NULL
                      END AS price_range,
                      pff.retail_price -- Keep for ordering price ranges
                 FROM products_for_faceting pff
              ),
              -- Calculate Aggregations using GROUPING SETS on the filtered set
              facet_aggregations AS (
                SELECT
                  COALESCE(brand, category, price_range) AS facet_value,
                  CASE
                    WHEN GROUPING(brand) = 0 THEN 'brand'
                    WHEN GROUPING(category) = 0 THEN 'category'
                    WHEN GROUPING(price_range) = 0 THEN 'price_range'
                  END AS facet_type,
                  COUNT(*) AS count,
                  MIN(retail_price) as min_price_for_ordering
                FROM
                  products_with_price_range -- Use the filtered data WITH price ranges
                WHERE
                    brand IS NOT NULL OR category IS NOT NULL OR price_range IS NOT NULL
                GROUP BY
                  GROUPING SETS (
                    (brand),
                    (category),
                    (price_range)
                  )
              )
            -- Final SELECT and ORDER BY from the aggregated results
            SELECT
              facet_value,
              facet_type,
              count
            FROM
              facet_aggregations
            ORDER BY
              facet_type ASC,
              CASE WHEN facet_type = 'price_range' THEN min_price_for_ordering ELSE NULL END ASC NULLS LAST,
              count DESC,
              facet_value ASC;
            `;

            // Execute with parameters for the facet filters
            const rows = await this.db.queryWithParams(queryTemplate, facetParams);
            const typedRows = camelCaseRows(rows) as RawFacet[];
            // Generate interpolated query for debugging if needed
            const interpolatedQuery = interpolateQuery(queryTemplate, facetParams);
            // NOTE: We return the *interpolated* query here for facet debugging
            return { data: typedRows, query: interpolatedQuery };

        } catch (error) {
            const errorDetail = `getFacets errored.\nSQL Template: ${queryTemplate?.substring(0,500)}...\nParams: ${JSON.stringify(facetParams)}\nError: ${(error as Error)?.message}`;
            console.error(errorDetail);
            const displayQuery = queryTemplate ? interpolateQuery(queryTemplate, facetParams) : 'Query construction failed';
            return { data: [], query: displayQuery, errorDetail: errorDetail };
        }
    }

    private async executeFinalQuery(
        finalQuery: string,
        params: any[],
        searchType: string,
    ): Promise<{ data: any[], query: string, interpolatedQuery: string, errorDetail?: string, searchType?: string }> {

        let executedQuery = finalQuery; // Keep track of what was actually run
        let resultRows: any[] = [];
        let interpolatedQueryString: string | undefined = ''; // For display

        try {
            if (params && params.length > 0) { 
                interpolatedQueryString = interpolateQuery(finalQuery, params);
            } else {
               interpolatedQueryString = finalQuery; // No params, query is already literal
            }

            let rows;
            rows = await this.db.queryWithParams(finalQuery, params);
            resultRows = rows;

            return {
                data: camelCaseRows(resultRows), // Apply camelCase
                query: executedQuery, // Show the query that was actually executed
                interpolatedQuery: interpolatedQueryString, //Return the interpolated version for display
                searchType: searchType
            };
        } catch (error) {
            const errorDetail = `Error executing final query: ${executedQuery} \nParams: ${JSON.stringify(params)}\nError: ${(error as Error)?.message}`;
            console.error(errorDetail);
            return { data: [], query: executedQuery, interpolatedQuery: interpolatedQueryString, errorDetail: errorDetail, searchType: searchType };
        }
    }

    async search(term: string, selectedFacets?: SelectedFacets) {
        const searchType = 'TRADITIONAL_SQL';
        let formattedSearchTerm = term.replace(/\s+/g, ' ').split(' ').join('%');
        const { clause: facetWhereClause, params: facetParams } = buildFacetWhereClause(selectedFacets ?? {});

        // Base query - use 'p' alias for products table
         let query = `
            SELECT
                p.name, p.product_image_uri, p.brand, p.product_description,
                p.category, p.department, p.cost, p.retail_price::MONEY, p.sku,
                'SQL' AS retrieval_method
            FROM products p
            WHERE (name ILIKE '%${safeString(formattedSearchTerm)}%'
                OR sku ILIKE '%${safeString(formattedSearchTerm)}%'
                OR category ILIKE '%${safeString(formattedSearchTerm)}%'
                OR brand ILIKE '%${safeString(formattedSearchTerm)}%'
                OR department ILIKE '%${safeString(formattedSearchTerm)}%'
                OR product_description ILIKE '%${safeString(formattedSearchTerm)}%')
            ${facetWhereClause}
            ORDER BY name
            LIMIT 12;`; // Consider if LIMIT should be applied before or after faceting

        // Note: This specific query uses ILIKE, making direct parameterization difficult.
        // For this example, we keep ILIKE and append the parameterized facet clause.
        // A better approach for production might involve FTS or different SQL structure.
        return this.executeFinalQuery(query, facetParams, searchType);
    }

    async fulltextSearch(term: string, selectedFacets?: SelectedFacets) {
        const searchType = 'FULLTEXT';
        const { clause: facetWhereClause, params: facetParams } = buildFacetWhereClause(selectedFacets ?? {});
        const ftsQueryFunction = 'websearch_to_tsquery'; // Or plainto_tsquery
        const ftsQuery = `${ftsQueryFunction}('english', '${safeString(term)}')`;

        // Combine base parameters with facet parameters
        // Note: The FTS part itself is not parameterized here for simplicity, only facets are.
        let allParams = [...facetParams];

         let query = `
            SELECT
                ts_rank(p.fts_document, ${ftsQuery}) AS fts_rank_score,
                p.name, p.product_image_uri, p.brand, p.product_description,
                p.category, p.department, p.cost, p.retail_price::MONEY, p.sku,
                'FTS' AS retrieval_method
            FROM products p
            WHERE p.fts_document @@ ${ftsQuery}
            ${facetWhereClause}
            ORDER BY fts_rank_score DESC
            LIMIT 12;`;

         return this.executeFinalQuery(query, allParams, searchType);
    }

    async semanticSearch(prompt: string, selectedFacets?: SelectedFacets) {
        const searchType = 'SEMANTIC';
        let { clause: facetWhereClause, params: facetParams } = buildFacetWhereClause(selectedFacets ?? {});
        
        if (facetWhereClause.startsWith('AND')) {
            facetWhereClause = facetWhereClause.replace('AND','WHERE')
        }

        const embeddingFunction = `embedding('text-embedding-005', '${safeString(prompt)}')::vector`;
        let allParams = [...facetParams]; // Start with facet params

        let query = `
            WITH vector_search AS (
                SELECT
                    p.embedding <=> ${embeddingFunction} AS distance,
                    p.name, 
                    p.product_image_uri, 
                    p.brand, 
                    p.product_description,
                    p.category, 
                    p.department, 
                    p.cost, 
                    p.retail_price::MONEY, 
                    p.sku,
                    'VECTOR' AS retrieval_method
                FROM products p
                ${facetWhereClause}
                ORDER BY distance
                LIMIT 1000
            ) SELECT * FROM vector_search WHERE distance < 0.65
             LIMIT 24;`;

         return this.executeFinalQuery(query, allParams, searchType);
    }

    async hybridSearch(term: string, selectedFacets?: SelectedFacets) {
        const searchType = 'HYBRID';
        const { clause: facetWhereClause, params: facetParams } = buildFacetWhereClause(selectedFacets ?? {});

        // Prepare terms safely
        let safeFtsTerm = safeString(term);
        let safeVectorTerm = safeString(term.replace(/\s+/g, ' ').replace(/'+/g, '').replace(/"+/g, '').replace(/-+/g, ''));
        let safeSqlTerm = safeString(term.replace(/\s+/g, ' ').split(' ').join('%')); // Basic transformation for SKU/ILIKE

        const topK = 40; // Candidates per method before RRF
        const limit = 12; // Final results limit
        const rrfK = 60;

        // Use placeholders in the query string and pass values via params array
        let query = `
            WITH trad_sql AS (
                SELECT RANK() OVER (ORDER BY name) AS trad_sql_rank, id FROM products WHERE sku = $${facetParams.length + 1} ORDER BY name LIMIT ${topK}
            ), fts_search AS (
                SELECT ts_rank(fts_document, websearch_to_tsquery('english', $${facetParams.length + 2})) AS score, RANK() OVER (ORDER BY ts_rank(fts_document, websearch_to_tsquery('english', $${facetParams.length + 2})) DESC) as rank, id
                FROM products WHERE fts_document @@ websearch_to_tsquery('english', $${facetParams.length + 2}) ORDER BY score DESC LIMIT ${topK}
            ), vector_search AS (
                SELECT embedding <=> embedding('text-embedding-005', $${facetParams.length + 3})::vector AS distance, RANK() OVER (ORDER BY embedding <=> embedding('text-embedding-005', $${facetParams.length + 3})::vector) AS rank, id
                FROM products ORDER BY distance LIMIT ${topK}
            ),
            -- Combine and rank
            combined_results AS (
                 SELECT
                    p.id, p.name, p.product_image_uri, p.brand, p.product_description, p.category, p.department, p.cost, p.retail_price, p.sku,
                    (
                      COALESCE( (1.0 / (${rrfK} + vector_search.rank)), 0.0 ) +
                      COALESCE( (1.0 / (${rrfK} + fts_search.rank)), 0.0 ) +
                      COALESCE( (1.0 / (${rrfK} + trad_sql.trad_sql_rank)), 0.0 )
                    ) AS rrf_score,
                    CONCAT_WS( '+',
                        CASE WHEN vector_search.rank IS NOT NULL THEN 'VECTOR' ELSE NULL END,
                        CASE WHEN fts_search.rank IS NOT NULL THEN 'FTS' ELSE NULL END,
                        CASE WHEN trad_sql.trad_sql_rank IS NOT NULL THEN 'SQL' ELSE NULL END
                    ) AS retrieval_method
                FROM products p
                LEFT JOIN vector_search ON p.id = vector_search.id
                LEFT JOIN fts_search ON p.id = fts_search.id
                LEFT JOIN trad_sql ON p.id = trad_sql.id
                WHERE (vector_search.id IS NOT NULL OR fts_search.id IS NOT NULL OR trad_sql.id IS NOT NULL)
                -- *** Apply Facet Filters AFTER combining candidates ***
                ${facetWhereClause}
            )
            -- Final Selection
            SELECT id, name, product_image_uri, brand, product_description, category, department, cost, retail_price::MONEY, sku, rrf_score, retrieval_method
            FROM combined_results
            ORDER BY rrf_score DESC
            LIMIT ${limit};
            `;

        // Combine facet parameters with the query-specific parameters
        let allParams = [...facetParams, safeSqlTerm, safeFtsTerm, safeVectorTerm];

        return this.executeFinalQuery(query, allParams, searchType);
    }

    async imageSearch(
        searchUri: string,
        selectedFacets?: SelectedFacets // Add facets parameter
    ) {
        let query;
        const searchType = 'IMAGE';
        const limit = 12; // Final limit after filtering

        // Build the facet WHERE clause and get parameters
        const { clause: facetWhereClause, params: facetParams } = buildFacetWhereClause(selectedFacets ?? {});

        try {
            console.log('Image search for:', searchUri, 'with facets:', selectedFacets);
            query = `
                WITH image_embedding AS (
                    SELECT ai.image_embedding(
                        model_id => 'multimodalembedding@001',
                        image => '${safeString(searchUri)}', -- searchUri needs escaping
                        mimetype => 'image/png')::vector AS embedding
                ), multimodal_candidates AS (
                    -- Find initial candidates based purely on image similarity
                    SELECT
                        p.id,
                        (p.product_image_embedding <=> ie.embedding) AS distance
                    FROM products p, image_embedding ie
                    WHERE p.product_image_embedding IS NOT NULL -- Ensure product has an image embedding
                    ORDER BY distance
                    LIMIT 100 -- Get a larger initial set of candidates to filter
                ),
                -- Join candidates with product details and apply facet filters
                filtered_candidates AS (
                     SELECT
                        mc.id,
                        mc.distance
                    FROM multimodal_candidates mc
                    JOIN products p ON mc.id = p.id -- Join back to products to access columns for filtering
                    WHERE 1=1 ${facetWhereClause} -- Apply facet WHERE clauses here
                    -- Parameters for facets will be passed to the final execution
                )
                -- Final selection and ranking
                SELECT
                    RANK () OVER (ORDER BY fc.distance) AS vector_rank,
                    p.id, p.name, p.product_image_uri, p.brand, p.product_description,
                    p.category, p.department, p.cost, p.retail_price::MONEY, p.sku,
                    'IMAGE' as retrieval_method -- Indicate retrieval method
                FROM filtered_candidates fc
                JOIN products p ON fc.id = p.id -- Join again to get all columns for final output
                ORDER BY fc.distance -- Order by the original vector distance
                LIMIT ${limit};`; // Apply final limit

            // Execute the query with facet parameters
            return this.executeFinalQuery(query, facetParams, searchType);

        } catch (error) {
            const errorDetail = `imageSearch errored with query fragment: ${query?.substring(0, 200)}...\nError: ${(error as Error)?.message}`;
            console.error(errorDetail);
            return { data: [], query: query ?? 'Query construction failed', errorDetail: errorDetail, searchType: searchType };
        }
    }
}
