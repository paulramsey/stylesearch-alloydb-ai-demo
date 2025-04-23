import { Component, Input, Output, EventEmitter, ChangeDetectorRef, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { QueryResponse, Product, FacetResponse, RawFacet, FacetGroup, Facet } from '../../services/cymbalshops-api';
import { Observable, Subscription, map } from 'rxjs';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTableModule } from '@angular/material/table';
import { MatDividerModule } from '@angular/material/divider';
import { MatListModule } from '@angular/material/list';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatGridListModule } from '@angular/material/grid-list';
import { TextToHtmlPipe } from '../../common/text-to-html.pipe';
import { SqlStatementComponent } from '../../common/sql-statement/sql-statement.component';
import { RoleService } from '../../services/cymbalshops-api';

@Component({
  selector: 'app-product-results',
  standalone: true,
  imports: [
    CommonModule, 
    MatCardModule,
    MatExpansionModule,
    SqlStatementComponent,
    TextToHtmlPipe,
    MatTableModule,
    MatDividerModule,
    MatListModule,
    MatCheckboxModule, 
    MatIconModule,
    MatGridListModule,
  ],
  templateUrl: './product-results.component.html',
  styleUrls: ['./product-results.component.scss'] 
})

export class ProductResultsComponent implements OnInit, OnDestroy {
  constructor (
    private cdr: ChangeDetectorRef,
    private RoleService: RoleService
  ) {}

  // --- Property to store the interpolated query for display ---
  interpolatedQuery?: string = undefined;

  // --- Inputs ---
  @Input() searchQuery: string | undefined;
  @Input() searchType: string | undefined;

  // Use setters to handle observable inputs and subscriptions
  private productsSub: Subscription | undefined;
  @Input()
  set productsResponse(observable: Observable<QueryResponse<Product>> | undefined) {
    this.productsSub?.unsubscribe(); // Unsubscribe from previous
    this.clearProductResults(); // Clear old data

    if (observable) {
      this.productsSub = observable.pipe(
        map(response => this.processProductResponse(response)) // Use map for transformation
      ).subscribe(processedResponse => {
          this.query = processedResponse.query;
          this.interpolatedQuery = processedResponse.interpolatedQuery;
          this.data = processedResponse.data;
          this.errorDetail = processedResponse.errorDetail;
          this.cdr.detectChanges();
      });
    }
  }

  private facetsSub: Subscription | undefined;
  @Input()
  set facetsResponse(observable: Observable<FacetResponse> | undefined) {
    this.facetsSub?.unsubscribe(); // Unsubscribe from previous

    if (observable) {
      // Always subscribe and process new facet data
      this.facetsSub = observable.subscribe(response => {
          if (response.data) {
            // Process the potentially updated facet data 
            this.processAndGroupFacets(response.data);
          } else if (response.errorDetail){
            console.error("Error fetching facets:", response.errorDetail);
            this.groupedFacets = []; // Clear on error
        } else {
            // Handle case where response has no data and no error (e.g., empty facets)
            this.groupedFacets = [];
        }
        // Checkboxes will automatically reflect the persisted `selectedFacets` state
        // against the newly rendered `groupedFacets` list.
        this.cdr.detectChanges();
      });
  } else {
      // Observable cleared (e.g., new search started in parent)
      this.clearAllFacetData(); // Use a method that clears both
      this.cdr.detectChanges();
  }

  }

  // --- Component State ---
  query?: string = undefined;
  data?: Product[] = undefined;
  generatedQuery?: string = undefined;
  errorDetail?: string = undefined;

  // Facet specific state
  groupedFacets: FacetGroup[] = []; // Array to hold grouped facets for the template
  selectedFacets: { [key: string]: string[] } = {}; // Persist the selected facet values { facetType: [value1, value2] }

  // --- Output event emitter ---
  @Output() facetSelectionChange = new EventEmitter<{ [key: string]: string[] }>();

  ngOnInit(): void {  }

  ngOnDestroy(): void {
      // Clean up subscriptions when the component is destroyed
      this.productsSub?.unsubscribe();
      this.facetsSub?.unsubscribe();
  }

  public clearProductResults(): void {
      this.data = undefined;
      this.query = undefined;
      this.errorDetail = undefined;
      this.interpolatedQuery = undefined;
  }

  public clearAllFacetData(): void {
      this.groupedFacets = [];
      this.selectedFacets = {};
      console.log("Cleared all facet data");

  }
  
  // Process Product Data (extracted logic)
  private processProductResponse(response: QueryResponse<Product>): QueryResponse<Product> {
    if (response.data && response.data.length > 0) {
      const modifiedData = response.data.map(product => {
        let modifiedProduct = { ...product };
        const stringToReplace = 'gs://genwealth-gen-vid';
        const replacementString = 'https://storage.googleapis.com/pr-public-demo-data/alloydb-retail-demo';
        if (modifiedProduct.productImageUri && typeof modifiedProduct.productImageUri === 'string') {
          modifiedProduct.productImageUri = modifiedProduct.productImageUri.replace(stringToReplace, replacementString);
        }
        const decimalPlaces = 7;
        if (modifiedProduct.rrfScore != null) {
          const factor = Math.pow(10, decimalPlaces);
          modifiedProduct.rrfScore = Math.round(modifiedProduct.rrfScore * factor) / factor;
        }
        return modifiedProduct;
      });
      return { ...response, data: modifiedData };
    }
    return response;
  }

  // Process and Group Facets
  private processAndGroupFacets(rawFacets: RawFacet[]): void {
      const facetMap = new Map<string, Facet[]>();

      rawFacets.forEach(facet => {
          const type = facet.facetType;
          if (!facetMap.has(type)) {
              facetMap.set(type, []);
          }
          facetMap.get(type)?.push({ value: facet.facetValue, count: facet.count });
      });

      // Convert map to array for the template, maintaining desired order
      this.groupedFacets = [];
      const order = ['brand', 'category', 'price_range']; // Define desired order
      order.forEach(type => {
          if (facetMap.has(type)) {
              this.groupedFacets.push({ type: this.formatFacetType(type), values: facetMap.get(type)! });
          }
      });

      // Add any remaining types (in case new ones appear)
      facetMap.forEach((values, type) => {
          if (!order.includes(type)) {
              this.groupedFacets.push({ type: this.formatFacetType(type), values });
          }
      });
  }

  // Helper to format facet type names for display
  formatFacetType(type: string): string {
      switch(type) {
          case 'brand': return 'Brand';
          case 'category': return 'Category';
          case 'price_range': return 'Price Range';
          default: return type.charAt(0).toUpperCase() + type.slice(1); // Capitalize first letter
      }
  }

  // Handle facet selection (checkbox click)
  onFacetChange(facetType: string, facetValue: string, isChecked: boolean): void {
    const typeKey = facetType.toLowerCase().replace(/\s+/g, '_');

    // Initialize if necessary
    if (!this.selectedFacets[typeKey]) {
       this.selectedFacets[typeKey] = [];
    }

    // Update selection
    const index = this.selectedFacets[typeKey].indexOf(facetValue);
    if (isChecked && index === -1) {
        this.selectedFacets[typeKey].push(facetValue);
    } else if (!isChecked && index > -1) {
        this.selectedFacets[typeKey].splice(index, 1);
    }

    // Clean up empty type arrays
    if (this.selectedFacets[typeKey].length === 0) {
        delete this.selectedFacets[typeKey];
    }
    
    // --- Emit the updated selection object ---
    this.facetSelectionChange.emit(this.selectedFacets);
}


   // Check if a specific facet value is currently selected
   isFacetSelected(facetType: string, facetValue: string): boolean {
     const typeKey = facetType.toLowerCase().replace(' ', '_');
     return this.selectedFacets[typeKey]?.includes(facetValue) ?? false;
  }

  getColumns(obj: any) {
    return Object.keys(obj);
  }

  getRows(obj: any) {
    return Object.values(obj);
  }
}
