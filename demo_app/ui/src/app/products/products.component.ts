import { Component, ChangeDetectorRef, OnInit, ApplicationRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CymbalShopsServiceClient, Product, QueryResponse, FacetResponse, RawFacet, ExplainQueryResponse } from '../services/cymbalshops-api';
import { Observable, catchError, finalize, forkJoin, map, of, tap } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatInputModule } from '@angular/material/input';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatRadioModule } from '@angular/material/radio';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ProductResultsComponent } from './results/product-results.component';
import { SqlViewerDialogComponent } from './sql-viewer-dialog/sql-viewer-dialog.component';
import { SnackBarErrorComponent } from '../common/SnackBarErrorComponent';
import { ActivatedRoute } from '@angular/router';
import { RoleService } from '../services/cymbalshops-api';
import { ImageSelectorComponent } from '../common/image-selector/image-selector.component';


export enum SearchType {
  TRADITIONAL_SQL = 'traditionalSql',
  TEXT_EMBEDDINGS = 'textEmbeddings',
  FULLTEXT = 'fulltext',
  NATURAL = 'natural',
  FREEFORM = 'freeform',
  HYBRID = 'hybrid',
  IMAGE = 'image',
}

@Component({
  selector: 'app-products',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    FormsModule,
    MatInputModule,
    MatCardModule,
    MatRadioModule,
    MatIconModule,
    MatTooltipModule,
    ProductResultsComponent,
    MatProgressSpinnerModule,
    ImageSelectorComponent,
    SqlViewerDialogComponent,
    MatSlideToggleModule
  ],
  templateUrl: './products.component.html',
  styleUrls: ['./products.component.scss'] 
})
export class ProductsComponent implements OnInit {

  // --- Product search properties ---
  searchTypes = SearchType; // Make enum accessible in template
  productSearch: string = '';
  searchType: string = SearchType.TRADITIONAL_SQL; // Default search type
  loading: boolean = false;
  productsResponse$?: Observable<QueryResponse<Product>> = undefined;
  facetsResponse$?: Observable<FacetResponse> = undefined;

  // --- Loading flags ---
  productsLoading: boolean = false;
  facetsLoading: boolean = false;

  // --- Get currently selected facets ---
  currentSelectedFacets: { [key: string]: string[] } = {};
  lastSearchTerm: string = ''; // Track last search term

  // --- Reference to the child component to call methods ---
  @ViewChild(ProductResultsComponent) productResultsComponent!: ProductResultsComponent;

  // AI Filter properties
  aiFilterEnabled: boolean = false;
  aiFilterText: string = '';
  lastAiFilterText: string = ''; // Track last AI filter text
  lastAiFilterEnabled: boolean = false; // Track last AI filter enabled state

  // --- Placeholders ---
  SEARCH_PLACEHOLDER = "What can we help you find?";
  SEARCH_PLACEHOLDER_IMAGE = "Enter a gs:// URI...";
  BUTTON_TEXT = "Find";
  LOADING_BUTTON_TEXT = "Searching";

  constructor(
    private CymbalShopsClient: CymbalShopsServiceClient,
    private error: SnackBarErrorComponent,
    private RoleService: RoleService,
    private ApplicationRef: ApplicationRef,
    private cdr: ChangeDetectorRef) { }

  ngOnInit(): void {
    console.log("Loading products component.")
  }

  // --- Handler for when the radio button selection changes ---
  onSearchTypeChanged(): void {
      console.log('Search type changed to:', this.searchType);
      // Reset selected facets in the parent component's state
      this.currentSelectedFacets = {};

      // Reset selected facets and UI in the child component
      if (this.productResultsComponent) {
          this.productResultsComponent.clearAllFacetData();
          this.productResultsComponent.clearProductResults();
      } else {
          console.warn("ProductResultsComponent not available to clear facets.");
      }

      this.productsLoading = false; // Ensure loading spinner stops
      this.facetsLoading = false; // Ensure loading spinner stops
      this.cdr.detectChanges(); // Force UI update

  }

  // --- Method to handle event from child product-results ---
  onFacetSelectionChanged(selectedFacets: { [key: string]: string[] }): void {
    console.log('Parent received facet change:', selectedFacets);
    this.currentSelectedFacets = selectedFacets;
    this.findProducts(); 
  }

  findProducts() {
    this.productsLoading = true;
    this.facetsLoading = true;

    const mainSearchTermChanged = this.productSearch !== this.lastSearchTerm;
    const aiFilterSettingsChanged = (this.aiFilterEnabled !== this.lastAiFilterEnabled) || (this.aiFilterEnabled && this.aiFilterText !== this.lastAiFilterText);

    // --- Reset facets state if it's an initial search (new main term OR new AI filter settings) ---
    // A change in selected facets alone should NOT reset this.
    if (mainSearchTermChanged) {
      console.log('New search context detected. Resetting facets.');
      this.currentSelectedFacets = {}; // Reset selected facets in PARENT
      if (this.productResultsComponent) {
        this.productResultsComponent.clearAllFacetData(); // Resets selectedFacets in CHILD
      }
      this.facetsResponse$ = undefined; // Ensure facets are refetched from scratch
    }

    // Update last known search parameters AFTER determining if it was a "new" search context
    this.lastSearchTerm = this.productSearch;
    this.lastAiFilterText = this.aiFilterText;
    this.lastAiFilterEnabled = this.aiFilterEnabled;
    // --- End reset logic modifications ---


    // Always clear product results when starting a find operation
    this.productsResponse$ = undefined; // Clear previous results

    console.log('Finding products with search:', this.productSearch, 
      'AI Filter Enabled:', this.aiFilterEnabled, 
      'AI Filter Text:', this.aiFilterText, 
      'and facets:', this.currentSelectedFacets);

    let productSearch$: Observable<QueryResponse<Product>>;
    const facetsToPass = this.currentSelectedFacets;

    // --- FACET FETCH LOGIC (adapt as needed) ---
    const currentSearchContext = this.productSearch + (this.aiFilterEnabled ? this.aiFilterText : '');
    const lastSearchContext = this.lastSearchTerm + (this.aiFilterEnabled ? this.aiFilterText : '');
    if (lastSearchContext !== currentSearchContext) { 
        if (this.productResultsComponent) {
            this.productResultsComponent.clearAllFacetData();
        }
        this.facetsResponse$ = undefined;
    }

    this.facetsResponse$ = this.CymbalShopsClient.getFacets(
      this.productSearch, 
      this.searchType, 
      facetsToPass
    ).pipe(
      catchError((err: any) => {
          this.error.showError('Unable to fetch facets', err);
          return of({ data: [], query: '', errorDetail: err.message || 'Failed to fetch facets' });
      }),
      finalize(() => {
        this.facetsLoading = false;
        this.cdr.detectChanges(); // Trigger change detection for facets loading
      })
  );
    // --- End Facet Fetch Logic ---

    switch (this.searchType) {
      case SearchType.TRADITIONAL_SQL:
        productSearch$ = this.CymbalShopsClient.searchProducts(
          this.productSearch, 
          facetsToPass,
          this.aiFilterEnabled ? this.aiFilterText : undefined
        );
        break;
      case SearchType.TEXT_EMBEDDINGS:
        productSearch$ = this.CymbalShopsClient.semanticSearchProducts(
          this.productSearch, 
          facetsToPass,
          this.aiFilterEnabled ? this.aiFilterText : undefined
        );
        break;
      case SearchType.FULLTEXT:
        productSearch$ = this.CymbalShopsClient.fulltextSearchProducts(
          this.productSearch, 
          facetsToPass,
          this.aiFilterEnabled ? this.aiFilterText : undefined
        );
        break;
      case SearchType.HYBRID:
        productSearch$ = this.CymbalShopsClient.hybridSearchProducts(
          this.productSearch, 
          facetsToPass,
          this.aiFilterEnabled ? this.aiFilterText : undefined
        );
        break;
      case SearchType.IMAGE:
        productSearch$ = this.CymbalShopsClient.imageSearchProducts(
          this.productSearch, 
          facetsToPass,
          this.aiFilterEnabled ? this.aiFilterText : undefined
        );
        break;
        default:
          console.error("Unsupported search type for products:", this.searchType);
          productSearch$ = of({ data: [], query: '', errorDetail: 'Invalid search type', searchType: this.searchType });
          break;
    }

    // Assign the observables directly. The results component will subscribe.
    this.productsResponse$ = productSearch$.pipe(
      catchError((err: any) => {
        this.error.showError('Unable to search products', err);
        // Return an observable of an empty QueryResponse on error
        return of({ data: [], query: err.query || 'Query failed', errorDetail: err.message || 'Failed to fetch products', searchType: this.searchType });
      }),
      finalize(() => {
        this.productsLoading = false;
        this.ApplicationRef.tick(); // May need manual tick depending on change detection
        this.cdr.detectChanges();
      })
    );

    // Trigger change detection after setting observables
    this.cdr.detectChanges();
  }

  onImageSelectedFromChild(selectedUri: string): void {
    // Update the parent component's property
    this.productSearch = selectedUri;

    // Optional: Automatically trigger search when an image is selected
    if (this.searchType === SearchType.IMAGE) {
      this.findProducts();
    }
  }

  getSuggestion() {
    switch (this.searchType) {
      case SearchType.TRADITIONAL_SQL:
        return "Black belt";
      case SearchType.FULLTEXT:
        return "Black belt";
      case SearchType.TEXT_EMBEDDINGS:
        return "Handbag";
      case SearchType.HYBRID:
        return "Handbag";
      case SearchType.IMAGE:
        return "gs://pr-public-demo-data/alloydb-retail-demo/user_photos/3.png";
      case SearchType.NATURAL:
        return "What are some popular purses my wife might like?";
      case SearchType.FREEFORM:
        return "SELECT * FROM products LIMIT 5;";
      default:
        return '';
    }
  }

}
