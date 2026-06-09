export default function PdpLoading() {
  return (
    <div style={{ padding: "16px 16px 80px" }}>
      {/* Back button placeholder */}
      <div
        style={{
          width: 80,
          height: 20,
          borderRadius: 4,
          marginBottom: 16,
        }}
        className="skeleton-shimmer"
      />
      {/* Hero image skeleton */}
      <div
        style={{ width: "100%", aspectRatio: "4/5", borderRadius: 6 }}
        className="skeleton-shimmer"
      />
      {/* Info skeleton */}
      <div style={{ marginTop: 16 }}>
        <div
          style={{ width: "40%", height: 12, borderRadius: 4, marginBottom: 8 }}
          className="skeleton-shimmer"
        />
        <div
          style={{ width: "60%", height: 28, borderRadius: 4, marginBottom: 16 }}
          className="skeleton-shimmer"
        />
        <div
          style={{ display: "flex", gap: 8, marginBottom: 16 }}
        >
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              style={{ width: 44, height: 44, borderRadius: "50%" }}
              className="skeleton-shimmer"
            />
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              style={{ width: 44, height: 44, borderRadius: 8 }}
              className="skeleton-shimmer"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
