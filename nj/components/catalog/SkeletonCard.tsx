export default function SkeletonCard() {
  return (
    <article className="card producto card--skeleton" aria-hidden="true">
      <div className="main-image-wrapper skeleton-shimmer" />
      <div className="card-info">
        <div
          className="skeleton-line skeleton-shimmer"
          style={{ width: "60%", height: 14 }}
        />
        <div
          className="skeleton-line skeleton-shimmer"
          style={{ width: "40%", height: 18, marginTop: 6 }}
        />
      </div>
    </article>
  );
}
