import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};

export default nextConfig;
