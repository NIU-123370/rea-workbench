// The UI is a shell over the local API: no rewrite here, because the proxy route handler
// decides its own forwarding policy (issue #18 / DESIGN §14).
//
// `allowedDevOrigins` is not cosmetics: Next 16 refuses dev resources for a Host it does not
// recognise, and in development that silently kills hydration - the page renders, every button
// is inert, and nothing says so. The browser pass hit exactly that by opening 127.0.0.1 while
// the dev origin was localhost, so both loopback spellings are named here.
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default config;
