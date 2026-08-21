import styles from "./conciliacion.module.css";

export default function ConciliacionReembolsoLoading() {
  return (
    <div className={styles.root}>
      <div className={styles.shell}>
        <p className={styles.eyebrow}>Admin · Contra reembolso</p>
        <h1 className={styles.title}>Conciliación de reembolso</h1>
        <p className={styles.subtitle}>Cargando métricas…</p>
      </div>
    </div>
  );
}
