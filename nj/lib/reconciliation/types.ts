export type SentDateOrigin = "sent_at" | "closed_at_fallback";

export type FinancialBucket =
  | "pending"
  | "approved_pending_confirmation"
  | "reconciled_exact"
  | "reconciled_open_irregularity"
  | "reconciled_resolved_irregularity";

export interface TransportOption {
  id: string;
  name: string;
}

export interface MonthOption {
  /** YYYY-MM o "all" */
  value: string;
  label: string;
}

export interface ReconciliationKpis {
  universeCount: number;
  universeAmount: number;
  pendingCount: number;
  pendingAmount: number;
  approvedWaitingCount: number;
  approvedWaitingAmount: number;
  reconciledTotalCount: number;
  reconciledTotalAmount: number;
  reconciledExactCount: number;
  reconciledExactAmount: number;
  reconciledOpenIrregularityCount: number;
  reconciledOpenIrregularityAmount: number;
  reconciledResolvedIrregularityCount: number;
  reconciledResolvedIrregularityAmount: number;
  openIrregularitiesCount: number;
  openDiffNegative: number;
  openDiffPositive: number;
  unassignedPaymentsCount: number;
  unassignedPaymentsAmount: number;
}

export interface PendingCodRow {
  id: string;
  orderNumber: string | null;
  displayName: string;
  titularName: string | null;
  labelName: string | null;
  effectiveSentDate: string;
  sentDateOrigin: SentDateOrigin;
  isEstimatedDate: boolean;
  transportId: string | null;
  transportName: string | null;
  amount: number;
  ageDays: number;
  isApprovedWaiting: boolean;
}

export interface ReconciliationFiltersState {
  month: string;
  transportId: string;
  q: string;
  page: number;
  /** Filtro de listado (no cambia KPIs): all | pending | waiting | reconciled */
  bucket: "all" | "pending" | "waiting" | "reconciled";
}

export interface ReconciliationDashboardData {
  kpis: ReconciliationKpis;
  pendingRows: PendingCodRow[];
  pendingTotal: number;
  pendingPage: number;
  pendingPageSize: number;
  transports: TransportOption[];
  months: MonthOption[];
  filters: ReconciliationFiltersState;
}
