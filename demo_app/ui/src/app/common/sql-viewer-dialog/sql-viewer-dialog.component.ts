import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common'; // Import CommonModule
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog'; // Import MAT_DIALOG_DATA and MatDialogModule
import { MatTabsModule } from '@angular/material/tabs';
import { MatButtonModule } from '@angular/material/button'; // For close button
import { SqlStatementComponent } from '../sql-statement/sql-statement.component'; // Adjust path if needed

// Interface for the data passed to the dialog
export interface SqlDialogData {
  productQuery: string | undefined;
  facetQuery: string | undefined;
}

@Component({
  selector: 'app-sql-viewer-dialog',
  standalone: true,
  imports: [
    CommonModule, // Add CommonModule
    MatDialogModule,
    MatTabsModule,
    MatButtonModule,
    SqlStatementComponent
  ],
  templateUrl: './sql-viewer-dialog.component.html',
  styleUrls: ['./sql-viewer-dialog.component.scss']
})
export class SqlViewerDialogComponent {
  // Inject MAT_DIALOG_DATA to receive data from the component that opened the dialog
  constructor(@Inject(MAT_DIALOG_DATA) public data: SqlDialogData) {}
}
