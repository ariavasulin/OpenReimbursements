# Configuration

[[README|← Back to Index]]

## Environment Variables

### Required: Supabase

```bash
# Public (exposed to browser)
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...

# Server-only (API routes)
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

### Required: AI/OCR

```bash
# OpenRouter (used for GPT-4.1-nano OCR)
OPENROUTER_API_KEY=sk-or-...
```

### Optional: Alternative AI Providers

```bash
OPENAI_API_KEY=sk-...        # For GPT-5 models
ANTHROPIC_API_KEY=sk-ant-... # For Claude models
```

## Package Scripts

```json
{
  "dev": "next dev --turbopack -H 0.0.0.0",
  "build": "next build",
  "start": "next start",
  "lint": "next lint"
}
```

## Key Config Files

### next.config.ts

```typescript
export default {
  serverExternalPackages: ['@boundaryml/baml'],  // BAML not bundled
  images: {
    remotePatterns: [{
      hostname: 'qebbmojnqzwwdpkhuyyd.supabase.co'  // Storage images
    }]
  },
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true }
};
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "strict": true,
    "paths": {
      "@/*": ["./src/*"],
      "@baml/*": ["./baml_client/*"]
    }
  }
}
```

### tailwind (via globals.css)

Using Tailwind CSS 4 with inline theme:

```css
@import "tailwindcss";
@import "tw-animate-css";

@theme inline {
  --color-primary: oklch(0.21 0.006 285.885);
  --color-secondary: oklch(0.27 0.005 286.033);
  /* ... shadcn design tokens */
}
```

### components.json (shadcn)

```json
{
  "style": "new-york",
  "rsc": true,
  "tailwind": {
    "baseColor": "neutral",
    "cssVariables": true
  },
  "iconLibrary": "lucide"
}
```

### vercel.json

```json
{
  "env": { "NEXT_ESLINT_DISABLED": "1" },
  "installCommand": "npm install --legacy-peer-deps"
}
```

## BAML Configuration

### generators.baml

```baml
generator target {
  output_type typescript
  output_dir "../"
  version "0.214.0"
  default_client_mode async
}
```

### clients.baml (primary)

```baml
client<llm> GPT4oMini {
  provider openai-generic
  options {
    base_url "https://openrouter.ai/api/v1"
    model "openai/gpt-4.1-nano"
    api_key env.OPENROUTER_API_KEY
  }
  retry_policy Exponential
}
```

## Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| next | 15.3.6 | Framework |
| react | 19 | UI library |
| @supabase/ssr | latest | SSR auth |
| @supabase/supabase-js | latest | Database client |
| @boundaryml/baml | latest | AI orchestration |
| @tanstack/react-query | latest | Data fetching |
| tailwindcss | 4 | Styling |
| sharp | latest | Image processing |
| sonner | latest | Toast notifications |
| lucide-react | latest | Icons |

## File Structure

```
dws-app/
├── .env.local           # Environment variables
├── next.config.ts       # Next.js config
├── tsconfig.json        # TypeScript config
├── package.json         # Dependencies
├── components.json      # shadcn config
├── vercel.json          # Deployment config
├── baml_src/            # BAML definitions
│   ├── clients.baml     # LLM clients
│   ├── generators.baml  # Code generation
│   └── receipts.baml    # Receipt extraction
└── src/
    └── app/
        └── globals.css  # Tailwind theme
```

## Development Setup

```bash
# Clone and install
cd dws-app
npm install

# Set up environment
cp .env.example .env.local
# Edit .env.local with your keys

# Run development server
npm run dev
```

## Deployment (Vercel)

1. Connect repo to Vercel
2. Set environment variables in Vercel dashboard
3. Build command: `npm run build`
4. Output directory: `.next`

ESLint disabled during builds via `NEXT_ESLINT_DISABLED=1`.

## Related Pages

- [[Architecture]] - System overview
- [[Database]] - Supabase setup
