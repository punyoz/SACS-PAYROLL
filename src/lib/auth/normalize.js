export function normalizeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

export function normalizeRole(value) {
  const role = normalizeText(value).toLowerCase();
  if (role === "admin") return "admin";
  if (role === "accountant") return "accountant";
  return "employee";
}

export function normalizeBncsEmail(emailInput) {
  const email = normalizeText(emailInput).toLowerCase();
  if (!email) return "";

  const atIndex = email.indexOf("@");
  if (atIndex <= 0 || atIndex === email.length - 1) {
    return "";
  }

  const localPart = email.slice(0, atIndex);
  const domainPart = email.slice(atIndex + 1);
  const normalizedLocalPart = localPart.startsWith("bncs.")
    ? localPart
    : `bncs.${localPart}`;

  return `${normalizedLocalPart}@${domainPart}`;
}

export function normalizeRoleEmail(emailInput, roleInput) {
  const role = normalizeRole(roleInput);

  if (role === "employee" || role === "accountant") {
    return normalizeBncsEmail(emailInput);
  }

  const email = normalizeText(emailInput).toLowerCase();
  const atIndex = email.indexOf("@");
  if (atIndex <= 0 || atIndex === email.length - 1) {
    return "";
  }

  return email;
}
