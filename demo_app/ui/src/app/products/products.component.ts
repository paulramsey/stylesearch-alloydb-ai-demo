import { Component, ChangeDetectorRef, OnInit, ApplicationRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CymbalShopsServiceClient, Product, QueryResponse, FacetResponse, RawFacet } from '../services/cymbalshops-api';
import { Observable, catchError, finalize, forkJoin, map, of, tap } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatInputModule } from '@angular/material/input';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatRadioModule } from '@angular/material/radio';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ProductResultsComponent } from './results/product-results.component';
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

  // --- Get currently selected facets ---
  currentSelectedFacets: { [key: string]: string[] } = {};
  lastSearchTerm: string = ''; // Track last search term

  // --- Reference to the child component to call its clear method ---
  @ViewChild(ProductResultsComponent) productResultsComponent!: ProductResultsComponent;


  // --- Placeholders ---
  SEARCH_PLACEHOLDER = "What can we help you find?";
  SEARCH_PLACEHOLDER_IMAGE = "Enter a gs:// URI...";
  BUTTON_TEXT = "Find";
  LOADING_BUTTON_TEXT = "Generating SQL";

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

      this.loading = false; // Ensure loading spinner stops
      this.cdr.detectChanges(); // Force UI update

  }

  // --- Method to handle event from child product-results ---
  onFacetSelectionChanged(selectedFacets: { [key: string]: string[] }): void {
    console.log('Parent received facet change:', selectedFacets);
    this.currentSelectedFacets = selectedFacets;
    this.findProducts(); // Pass false to indicate it's NOT an initial search
  }

  findProducts() {
    this.loading = true;

    // --- Reset facets state if it's an initial search (new term OR new type) ---
    if (this.productSearch !== this.lastSearchTerm) {
      this.currentSelectedFacets = {}; // Reset selected facets
      this.lastSearchTerm = this.productSearch; // Update last search term
      // Clear existing facet display in child before fetching new ones
      if (this.productResultsComponent) {
        this.productResultsComponent.clearAllFacetData();
      }
      this.facetsResponse$ = undefined; // Ensure facets are refetched
    } 
    // --- End reset logic ---

    // Always clear product results when starting a find operation
    this.productsResponse$ = undefined; // Clear previous results

    console.log('Finding products with search:', this.productSearch, 'and facets:', this.currentSelectedFacets);

    let productSearch$: Observable<QueryResponse<Product>>;
    const facetsToPass = this.currentSelectedFacets;

    // --- ALWAYS Fetch Facets, passing current selection ---
    this.facetsResponse$ = this.CymbalShopsClient.getFacets(this.productSearch, this.searchType, facetsToPass).pipe(
      catchError((err: any) => {
          this.error.showError('Unable to fetch facets', err);
          return of({ data: [], query: '', errorDetail: err.message || 'Failed to fetch facets' });
      }),
      // tap(() => this.cdr.detectChanges()) // May not be needed if async pipe handles it
  );
    // --- End Facet Fetch Logic ---


    switch (this.searchType) {
      case SearchType.TRADITIONAL_SQL:
        productSearch$ = this.CymbalShopsClient.searchProducts(this.productSearch, facetsToPass);
        break;
      case SearchType.TEXT_EMBEDDINGS:
        productSearch$ = this.CymbalShopsClient.semanticSearchProducts(this.productSearch, facetsToPass);
        break;
      case SearchType.FULLTEXT:
        productSearch$ = this.CymbalShopsClient.fulltextSearchProducts(this.productSearch, facetsToPass);
        break;
      case SearchType.HYBRID:
        productSearch$ = this.CymbalShopsClient.hybridSearchProducts(this.productSearch, facetsToPass);
        break;
      case SearchType.IMAGE:
        productSearch$ = this.CymbalShopsClient.imageSearchProducts(this.productSearch, facetsToPass);
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
        this.loading = false;
        this.ApplicationRef.tick(); // May need manual tick depending on change detection
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
        return "Coach purse";
      case SearchType.HYBRID:
        return "Coach purse";
      case SearchType.IMAGE:
        return "gs://pr-public-demo-data/alloydb-retail-demo/user_photos/1.png";
      case SearchType.NATURAL:
        return "What are some popular purses my wife might like?";
      case SearchType.FREEFORM:
        return "SELECT * FROM products LIMIT 5;";
      default:
        return '';
    }
  }

}
