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

export function normalizeRoleEmail(emailInput) {
  const email = normalizeText(emailInput).toLowerCase();
  const atIndex = email.indexOf("@");
  if (atIndex <= 0 || atIndex === email.length - 1) {
    return "";
  }
  return email;
}
