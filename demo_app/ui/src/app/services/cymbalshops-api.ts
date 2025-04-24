import { HttpClient, HttpParams } from '@angular/common/http';
import { Inject, Injectable } from '@angular/core';
import { Observable, BehaviorSubject, map } from 'rxjs';
import { BASE_URL } from '../app.config';

// --- Interface for raw facet data from API ---
export interface RawFacet {
    facetValue: string; // Note: camelCase from backend transformation
    facetType: 'brand' | 'category' | 'price_range';
    count: number;
}

// --- Interfaces for structured facet data in the component ---
export interface Facet {
    value: string;
    count: number;
}

export interface FacetGroup {
    type: string; // 'brand', 'category', or 'price_range'
    values: Facet[];
}

// --- Interface for the facet API response ---
export interface FacetResponse {
    query?: string;
    data?: RawFacet[];
    errorDetail?: string;
}

export interface QueryResponse<T> {
    query?: string;
    interpolatedQuery?: string | undefined;
    data?: T[];
    errorDetail?: string;
    searchType: string | undefined;
    facets?: FacetGroup[];
    totalCount?: number;
}

export interface ExplainQueryResponse<T> {
    query?: string;
    data?: T[];
    errorDetail?: string;
}

export interface Product {
    id?: number;
    cost?: number;
    category?: string;
    name?: string;
    brand?: string;
    retailPrice?: number;
    department?: string;
    sku?: string;
    distributionCenterId?: number;
    embedding?: string;
    embeddingModelVerion?: string;
    productDescription?: string;
    productDescriptionEmbedding?: string;
    productDescriptionEmbeddingModel?: string;
    productImageUri?: string;
    productImageEmbedding?: string;
    productImageEmbeddingModel?: string;
    ftsDocument?: string;
    sparseEmbedding?: string;
    sparseEmbeddingModel?: string;
    retrievalMethod?: string;
    rrfScore?: number;
    distance?: number;
}

export interface CymbalShopsService {
    searchProducts(term: string, facets?: { [key: string]: string[] }): Observable<QueryResponse<Product>>;
    fulltextSearchProducts(term: string, facets?: { [key: string]: string[] }): Observable<QueryResponse<Product>>;
    semanticSearchProducts(prompt: string, facets?: { [key: string]: string[] }): Observable<QueryResponse<Product>>;
    hybridSearchProducts(term: string, facets?: { [key: string]: string[] }): Observable<QueryResponse<Product>>;
    imageSearchProducts(searchUri: string, facets?: { [key: string]: string[] }): Observable<QueryResponse<Product>>;
    getFacets(term: string, searchType: string, facets?: { [key: string]: string[] }): Observable<FacetResponse>;
}

@Injectable({
    providedIn: 'root'
})
export class CymbalShopsServiceClient implements CymbalShopsService {
    constructor(private http: HttpClient, @Inject(BASE_URL) private baseUrl: string) {}

    // Helper to build parameters including optional facets
    private buildParams(baseParams: { [param: string]: string | number | boolean }, facets?: { [key: string]: string[] }): HttpParams {
        let params = new HttpParams({ fromObject: baseParams });
        if (facets && Object.keys(facets).length > 0) {
            // Stringify the facets object and add it as a single query parameter
            params = params.set('facets', JSON.stringify(facets));
        }
        return params;
    }

    searchProducts(term: string, facets?: { [key: string]: string[] }): Observable<QueryResponse<Product>> {
        const baseParams = {
            term: term
        };
        const params = this.buildParams(baseParams, facets);
        return this.http.get<QueryResponse<Product>>(`${this.baseUrl}/products/search`, { params });
    }

    fulltextSearchProducts(term: string, facets?: { [key: string]: string[] }): Observable<QueryResponse<Product>> {
         const baseParams = {
            term: term
        };
        const params = this.buildParams(baseParams, facets);
        return this.http.get<QueryResponse<Product>>(`${this.baseUrl}/products/fulltext-search`, { params });
    }

    semanticSearchProducts(prompt: string, facets?: { [key: string]: string[] }): Observable<QueryResponse<Product>> {
         const baseParams = {
            prompt: prompt
        };
        const params = this.buildParams(baseParams, facets);
        return this.http.get<QueryResponse<Product>>(`${this.baseUrl}/products/semantic-search`, { params });
    }

    hybridSearchProducts(term: string, facets?: { [key: string]: string[] }): Observable<QueryResponse<Product>> {
         const baseParams = {
            term: term
        };
        const params = this.buildParams(baseParams, facets);
        return this.http.get<QueryResponse<Product>>(`${this.baseUrl}/products/hybrid-search`, { params });
    }

    imageSearchProducts(searchUri: string, facets?: { [key: string]: string[] }): Observable<QueryResponse<Product>> {
        const baseParams = {
           searchUri: searchUri
       };
       const params = this.buildParams(baseParams, facets); // Use helper to add facets
       return this.http.get<QueryResponse<Product>>(`${this.baseUrl}/products/image-search`, { params });
   }

   getFacets(term: string, searchType: string = 'hybrid', facets?: { [key: string]: string[] }): Observable<FacetResponse> {
        const baseParams: { [param: string]: string } = {
            term: term,
            searchType: searchType // Include searchType for context
        };
        // Use the existing buildParams helper to potentially add the 'facets' parameter
        const params = this.buildParams(baseParams, facets);
        return this.http.get<FacetResponse>(`${this.baseUrl}/products/facets`, { params });
    }

    explainQuery(queryString: string): Observable<ExplainQueryResponse<any>> {
        const baseParams = {
            queryString: queryString
        };
        const params = this.buildParams(baseParams);
        return this.http.get<ExplainQueryResponse<Product>>(`${this.baseUrl}/products/explain-query`, { params });
    }
}

@Injectable({
    providedIn: 'root'
})
export class RoleService {
  private roleChangeSource = new BehaviorSubject<Map<string, Array<number | null>> 
 | undefined>(undefined);
  role$ = this.roleChangeSource.asObservable(); 

  updateRole(newRole: Map<string, Array<number | null>> | undefined) {
    this.roleChangeSource.next(newRole);
  }

  lookupRoleDetails(role: string): Map<string, Array<number | null>> | undefined {
    // Array should be formed as follows:
    // ["Role (Name)", [role_id, subscription_id]]
    const roleMap: Map<string, Array<number | null>> = new Map([
      ["Shopper (Paul Ramsey)", [1, 2]],
      ["Shopper (Evelyn Sterling)", [2, 2]],
      ["Shopper (Arthur Kensington)", [3, 2]],
      ["Shopper (Penelope Wainwright)", [4, 2]],
      ["Shopper (Sebastian Thorne)", [5, 2]],
      ["Admin", [0, 2]]
    ]);
  
    const id = roleMap.get(role);
  
    if (id !== undefined) {
      return new Map([[role, id]]); // Create a new Map with the role and its ID
    } else {
      return undefined;
    }
  }
}