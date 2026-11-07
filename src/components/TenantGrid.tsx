import {
  CellStyleModule,
  ClientSideRowModelModule,
  ModuleRegistry,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';

ModuleRegistry.registerModules([ClientSideRowModelModule, CellStyleModule]);

const columnDefs = [
  { field: 'fullName', headerName: 'Tenant', sortable: true, flex: 1, minWidth: 130 },
  { field: 'outstandingAmount', headerName: 'Owed', sortable: true, flex: 1, minWidth: 100 },
  { field: 'monthsOverdue', headerName: 'Months Overdue', sortable: true, flex: 1, minWidth: 130 },
  {
    field: 'status',
    headerName: 'Status',
    flex: 1,
    minWidth: 100,
    cellStyle: (params: { value: string }) => params.value === 'paid'
      ? { color: '#087443', fontWeight: '700' }
      : undefined,
  },
];

export function TenantGrid({ rows }: { rows: any[] }) {
  return (
    <div className="ag-theme-quartz" style={{ height: 400, width: '100%' }}>
      <AgGridReact rowData={rows} columnDefs={columnDefs} theme="legacy" />
    </div>
  );
}
