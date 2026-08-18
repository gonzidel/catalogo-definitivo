import styles from "@/app/admin/products/products-admin.module.css";

export default function AccessDenied({ reason }: { reason: string }) {
  return (
    <div className={styles.deniedBox}>
      <h1>Sin acceso</h1>
      <p>{reason}</p>
    </div>
  );
}
