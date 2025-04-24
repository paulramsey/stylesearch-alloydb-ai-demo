import { Component, Input, Output, EventEmitter, ChangeDetectorRef, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { QueryResponse, Product, FacetResponse, RawFacet, FacetGroup, Facet } from '../../services/cymbalshops-api';
import { Observable, Subscription, map } from 'rxjs';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTableModule } from '@angular/material/table';
import { MatTabsModule } from '@angular/material/tabs';
import { MatDividerModule } from '@angular/material/divider';
import { MatListModule } from '@angular/material/list';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatGridListModule } from '@angular/material/grid-list';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog'; // Import MatDialog
import { TextToHtmlPipe } from '../../common/text-to-html.pipe';
import { SqlStatementComponent } from '../../common/sql-statement/sql-statement.component';
import { SqlViewerDialogComponent } from '../sql-viewer-dialog/sql-viewer-dialog.component';
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
    MatButtonModule,
    MatTabsModule,
    MatDialogModule,
    SqlViewerDialogComponent
  ],
  templateUrl: './product-results.component.html',
  styleUrls: ['./product-results.component.scss']
})

export class ProductResultsComponent implements OnInit, OnDestroy {
  constructor(
    private cdr: ChangeDetectorRef,
    private RoleService: RoleService,
    public dialog: MatDialog
  ) { }

  // --- Property to store the interpolated query for display ---
  public interpolatedQuery?: string = undefined;
  public facetInterpolatedQuery?: string = undefined;

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
        this.totalCount = processedResponse.totalCount;
        this.cdr.detectChanges();
      });
    }
  }

  private facetsSub: Subscription | undefined;
  @Input()
  set facetsResponse(observable: Observable<FacetResponse> | undefined) {
    this.facetsSub?.unsubscribe(); // Unsubscribe from previous
    this.expandedFacets = {}; // Reset facet expansion state

    if (observable) {
      // Always subscribe and process new facet data
      this.facetsSub = observable.subscribe(response => {
        this.facetInterpolatedQuery = response.query;
        if (response.data) {
          // Process the potentially updated facet data 
          this.processAndGroupFacets(response.data);
        } else if (response.errorDetail) {
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
  public query?: string = undefined;
  data?: Product[] = undefined;
  generatedQuery?: string = undefined;
  errorDetail?: string = undefined;
  totalCount?: number | undefined = undefined;

  // Facet specific state
  groupedFacets: FacetGroup[] = []; // Array to hold grouped facets for the template
  selectedFacets: { [key: string]: string[] } = {}; // Persist the selected facet values { facetType: [value1, value2] }

  // --- Properties for facet expansion ---
  readonly INITIAL_FACET_COUNT = 5; // Number of facets to show initially
  expandedFacets: { [facetTypeKey: string]: boolean } = {}; // e.g., { 'brand': false, 'category': false }

  // --- Output event emitter ---
  @Output() facetSelectionChange = new EventEmitter<{ [key: string]: string[] }>();

  ngOnInit(): void { }

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
    this.totalCount = undefined;
  }

  public clearAllFacetData(): void {
    this.groupedFacets = [];
    this.selectedFacets = {};
    this.expandedFacets = {}; 
    this.facetInterpolatedQuery = undefined;
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
    switch (type) {
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

  /** Checks if a facet group should have a "Show more/less" button */
  isExpandable(group: FacetGroup): boolean {
    const groupTypeKey = group.type.toLowerCase();
    // *** CHANGE: Define which groups are expandable ***
    const expandableTypes = ['brand', 'category']; // Add 'category'
    return expandableTypes.includes(groupTypeKey) && group.values.length > this.INITIAL_FACET_COUNT;
  }

 /** Checks if a specific group type is currently expanded */
 isGroupExpanded(groupType: string): boolean {
    const groupTypeKey = groupType.toLowerCase();
    // Return the state from the map, default to false if not present
    return !!this.expandedFacets[groupTypeKey];
 }

  /** Toggles the expansion state for a given facet group type */
  toggleExpansion(groupType: string): void {
    const groupTypeKey = groupType.toLowerCase(); // Use lowercase key
    this.expandedFacets[groupTypeKey] = !this.isGroupExpanded(groupType); // Toggle state in map
    this.cdr.detectChanges(); // Trigger change detection
  }

  /** Gets the facets to display (sliced or full) based on expansion state */
  getSlicedFacets(group: FacetGroup): Facet[] {
      const groupTypeKey = group.type.toLowerCase();
      // Slice only if the group is expandable AND currently not expanded
      if (this.isExpandable(group) && !this.isGroupExpanded(group.type)) {
          return group.values.slice(0, this.INITIAL_FACET_COUNT);
      }
      return group.values; // Return all if not expandable or already expanded
  }

  // Add method to open the SQL query dialog
  public openSqlDialog(): void {
    // Only open if there's actually a query to show
    if (this.interpolatedQuery || this.query || this.facetInterpolatedQuery) {
        this.dialog.open(SqlViewerDialogComponent, {
          width: '80%', // Adjust size as needed
          maxWidth: '900px', // Optional max width
          maxHeight: '80vh', // Optional max height
          data: { // Pass the queries to the dialog component
            productQuery: this.interpolatedQuery ? this.interpolatedQuery : this.query,
            facetQuery: this.facetInterpolatedQuery
          }
        });
    }
  }

  getColumns(obj: any) {
    return Object.keys(obj);
  }

  getRows(obj: any) {
    return Object.values(obj);
  }
}
