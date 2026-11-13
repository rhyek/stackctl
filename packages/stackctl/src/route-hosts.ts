// The hostnames a reverse proxy's routes name: what the proxy serves and what its certificates
// cover, apart from the proxy's own module and the network modules it loads.

/**
 * Every hostname a route names, under each domain: each subdomain but `'*'`, in the order the
 * routes list them. (A host `'*'` routes is any other one, so it has no name to list.)
 */
export function routeHosts(routes: { subdomain: string[] }[], domains: string[]): string[] {
  const subdomains = routes.flatMap((entry) => entry.subdomain.filter((s) => s !== '*'));
  return domains.flatMap((domain) => subdomains.map((subdomain) => `${subdomain}.${domain}`));
}
