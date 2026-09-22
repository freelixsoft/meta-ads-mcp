/**
 * Route prefixes for the dashboard, in a module with no imports so the
 * transport layer can reference them without pulling in Express middleware or
 * creating a cycle with the auth routes.
 */
export const DASHBOARD_PATH = "/dashboard";
export const DASHBOARD_API_PATH = "/api/dashboard";
