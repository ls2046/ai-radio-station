import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  devIndicators: false,
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "192.168.30.100",
    "192.168.31.16"
  ]
};

export default nextConfig;
