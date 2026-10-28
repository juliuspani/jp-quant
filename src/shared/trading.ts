// Tipos base de trading (ARCHITECTURE.md §16.1). Solo spot: una compra abre o amplía, una venta reduce.
export type Side = 'buy' | 'sell';
export type Bucket = 'core' | 'scout'; // núcleo o explorador de monedas pequeñas (trading-risk §4.3)
