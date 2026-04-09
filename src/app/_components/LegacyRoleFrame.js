export default function LegacyRoleFrame({ role }) {
  const src = role
    ? `/legacy/index.html?role=${encodeURIComponent(role)}`
    : "/legacy/index.html";

  return (
    <main style={{ width: "100%", height: "100dvh", overflow: "hidden" }}>
      <iframe
        src={src}
        title={`${role} portal`}
        style={{ width: "100%", height: "100%", border: "none" }}
      />
    </main>
  );
}
