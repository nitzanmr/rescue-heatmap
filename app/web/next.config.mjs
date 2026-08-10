/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // required for the Docker image (multi-stage runtime copies .next/standalone)
  output: "standalone",
};
export default nextConfig;
