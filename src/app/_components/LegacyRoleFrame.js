export default function LegacyRoleFrame({ role }) {
  const src = role
    ? `/legacy/index.html?role=${encodeURIComponent(role)}`
    : "/legacy/index.html";

  return (
    <main style={{ width: "100%", minHeight: "100dvh", overflow: "auto" }}>
      <iframe
        src={src}
        title={`${role} portal`}
        style={{ width: "100%", height: "100dvh", border: "none", display: "block" }}
      />
    </main>
  );
}
