/** @type {import('next').NextConfig} */

// Where the API lives as seen from the Next server process.
//   compose      -> http://api:8080
//   local dev    -> http://localhost:8080
//   Cloud Run    -> the API service URL
const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:8080";

const nextConfig = {
  reactStrictMode: true,
  // required for the Docker image (multi-stage runtime copies .next/standalone)
  output: "standalone",

  // The browser talks to a RELATIVE /api path and Next forwards it. This is not
  // cosmetic:
  //   - same-origin means no CORS, no preflight on every intake POST, and one
  //     less hostname to get right during an activation;
  //   - the API's internal address never reaches the browser, so moving the API
  //     is a server-side env change, not a rebuild of the client;
  //   - a phone on a bad network pays one DNS lookup instead of two.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/:path*` }];
  },
};

export default nextConfig;
