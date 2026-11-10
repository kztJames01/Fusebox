import { z } from "zod";

export const CategorySchema = z.enum([
  "auth",
  "api",
  "components",
  "utils",
  "config",
  "test",
  "styles",
  "other",
]);

export type Category = z.infer<typeof CategorySchema>;

export const ALL_CATEGORIES: readonly Category[] = CategorySchema.options;

export const CATEGORY_PRIORITY: Record<Category, number> = {
  auth: 100,
  api: 90,
  components: 80,
  utils: 70,
  config: 60,
  test: 50,
  styles: 40,
  other: 0,
};

export const CATEGORY_EMOJI: Record<Category, string> = {
  auth: "\u{1F510}",
  api: "\u{1F310}",
  components: "\u{1F9E9}",
  utils: "\u{1F527}",
  config: "\u{2699}\u{FE0F}",
  test: "\u{1F9EA}",
  styles: "\u{1F3A8}",
  other: "\u{1F4E6}",
};

export const PATH_REGISTRY: Record<string, { tech: string; simple: string; category: Category }> = {
  "auth/": {
    tech: "Authentication & session middleware",
    simple: "User login & security checks",
    category: "auth",
  },
  "authentication/": {
    tech: "Authentication & session middleware",
    simple: "User login & security checks",
    category: "auth",
  },
  "login/": {
    tech: "Authentication & session middleware",
    simple: "User login & security checks",
    category: "auth",
  },
  "api/": {
    tech: "REST client & error handling",
    simple: "Data connection & API layer",
    category: "api",
  },
  "route": {
    tech: "REST client & error handling",
    simple: "Data connection & API layer",
    category: "api",
  },
  "endpoint": {
    tech: "REST client & error handling",
    simple: "Data connection & API layer",
    category: "api",
  },
  "components/": {
    tech: "View components & state consumers",
    simple: "Screen UI & layout blocks",
    category: "components",
  },
  "ui/": {
    tech: "View components & state consumers",
    simple: "Screen UI & layout blocks",
    category: "components",
  },
  "widgets/": {
    tech: "View components & state consumers",
    simple: "Screen UI & layout blocks",
    category: "components",
  },
  "utils/": {
    tech: "Pure helper functions",
    simple: "Reusable logic (format, validate)",
    category: "utils",
  },
  "helpers/": {
    tech: "Pure helper functions",
    simple: "Reusable logic (format, validate)",
    category: "utils",
  },
  "lib/": {
    tech: "Library utilities",
    simple: "Reusable logic (format, validate)",
    category: "utils",
  },
  "shared/": {
    tech: "Pure helper functions",
    simple: "Reusable logic (format, validate)",
    category: "utils",
  },
  "db/": {
    tech: "Schema definitions & query layer",
    simple: "Data storage & retrieval rules",
    category: "config",
  },
  "database/": {
    tech: "Schema definitions & query layer",
    simple: "Data storage & retrieval rules",
    category: "config",
  },
  "models/": {
    tech: "Data models & schema definitions",
    simple: "Data storage & retrieval rules",
    category: "config",
  },
  "config/": {
    tech: "Configuration & environment setup",
    simple: "App settings & preferences",
    category: "config",
  },
  "setting": {
    tech: "Configuration & environment setup",
    simple: "App settings & preferences",
    category: "config",
  },
  "types/": {
    tech: "TypeScript type definitions",
    simple: "Data structure definitions",
    category: "config",
  },
  "styles/": {
    tech: "CSS/SCSS overrides & theming",
    simple: "Visual design & layout updates",
    category: "styles",
  },
  "css/": {
    tech: "CSS/SCSS overrides & theming",
    simple: "Visual design & layout updates",
    category: "styles",
  },
  "test/": {
    tech: "Unit & integration specifications",
    simple: "Quality checks & test coverage",
    category: "test",
  },
  "tests/": {
    tech: "Unit & integration specifications",
    simple: "Quality checks & test coverage",
    category: "test",
  },
  "__tests__/": {
    tech: "Unit & integration specifications",
    simple: "Quality checks & test coverage",
    category: "test",
  },
};

const EXT_CATEGORY_MAP: Record<string, Category> = {
  ".ts": "utils",
  ".tsx": "components",
  ".js": "utils",
  ".jsx": "components",
  ".py": "utils",
  ".pyi": "config",
  ".rs": "utils",
  ".go": "utils",
  ".css": "styles",
  ".scss": "styles",
  ".less": "styles",
  ".json": "config",
  ".yml": "config",
  ".yaml": "config",
  ".md": "other",
};

export function categorizeFile(filePath: string): Category {
  const lowerPath = filePath.toLowerCase();

  for (const [pattern, data] of Object.entries(PATH_REGISTRY)) {
    if (lowerPath.includes(pattern.toLowerCase())) {
      return data.category;
    }
  }

  const basename = lowerPath.split("/").pop() ?? "";
  if (basename.includes("test") || basename.includes(".spec.") || basename.includes(".test.")) {
    return "test";
  }
  if (basename.includes("config") || basename.includes(".config.")) return "config";
  if (basename.includes("auth")) return "auth";
  if (basename.includes("api")) return "api";
  if (/\.(css|scss|less|styl|sass)$/.test(basename)) return "styles";

  const ext = "." + (basename.split(".").pop() ?? "");
  return EXT_CATEGORY_MAP[ext] ?? "other";
}

export function getRegistryEntry(
  filePath: string
): typeof PATH_REGISTRY[string] | undefined {
  const lowerPath = filePath.toLowerCase();
  for (const [pattern, data] of Object.entries(PATH_REGISTRY)) {
    if (lowerPath.includes(pattern.toLowerCase())) {
      return data;
    }
  }
  return undefined;
}
