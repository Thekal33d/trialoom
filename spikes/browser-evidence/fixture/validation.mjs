// Deliberate seed defect: the local-part pattern excludes valid plus aliases.
export function isValidInvitationEmail(email) {
  return typeof email === 'string' && /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email);
}
