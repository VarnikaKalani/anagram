import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Helvetica Neue", "Arial", "Segoe UI", "sans-serif"],
        heading: ["Helvetica Neue", "Arial", "Segoe UI", "sans-serif"]
      },
      colors: {
        game: {
          bg: "#f5f5f5",
          panel: "#ffffff",
          line: "#d9d9d9",
          ink: "#111111",
          muted: "#666666",
          accent: "#222222"
        }
      },
      boxShadow: {
        soft: "0 1px 2px rgba(0, 0, 0, 0.08)"
      }
    }
  },
  plugins: []
};

export default config;
