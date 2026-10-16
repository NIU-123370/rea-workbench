// The UI is a shell over the local API: no rewrite here, because the proxy route handler
// decides its own forwarding policy (issue #18 / DESIGN §14).
const config = { reactStrictMode: true, poweredByHeader: false };

export default config;
