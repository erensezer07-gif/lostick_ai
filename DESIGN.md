---
name: Lostick AI
colors:
  surface: '#131313'
  surface-dim: '#131313'
  surface-bright: '#3a3939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1c1b1b'
  surface-container: '#201f1f'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353534'
  on-surface: '#e5e2e1'
  on-surface-variant: '#d4c5ab'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#313030'
  outline: '#9c8f78'
  outline-variant: '#4f4632'
  surface-tint: '#fabd00'
  primary: '#ffe4af'
  on-primary: '#3f2e00'
  primary-container: '#ffc107'
  on-primary-container: '#6d5100'
  inverse-primary: '#785900'
  secondary: '#c8c6c5'
  on-secondary: '#313030'
  secondary-container: '#474746'
  on-secondary-container: '#b7b5b4'
  tertiary: '#e9e6e6'
  on-tertiary: '#303030'
  tertiary-container: '#cccaca'
  on-tertiary-container: '#555555'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#ffdf9e'
  primary-fixed-dim: '#fabd00'
  on-primary-fixed: '#261a00'
  on-primary-fixed-variant: '#5b4300'
  secondary-fixed: '#e5e2e1'
  secondary-fixed-dim: '#c8c6c5'
  on-secondary-fixed: '#1c1b1b'
  on-secondary-fixed-variant: '#474746'
  tertiary-fixed: '#e4e2e1'
  tertiary-fixed-dim: '#c8c6c6'
  on-tertiary-fixed: '#1b1c1c'
  on-tertiary-fixed-variant: '#474747'
  background: '#131313'
  on-background: '#e5e2e1'
  surface-variant: '#353534'
typography:
  display-lg:
    fontFamily: Hanken Grotesk
    fontSize: 56px
    fontWeight: '800'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Hanken Grotesk
    fontSize: 32px
    fontWeight: '700'
    lineHeight: '1.2'
  headline-lg-mobile:
    fontFamily: Hanken Grotesk
    fontSize: 24px
    fontWeight: '700'
    lineHeight: '1.2'
  headline-md:
    fontFamily: Hanken Grotesk
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.3'
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: '1.0'
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 8px
  xs: 4px
  sm: 12px
  md: 24px
  lg: 48px
  xl: 80px
  gutter: 24px
  margin-desktop: 64px
  margin-mobile: 20px
---

## Brand & Style
The design system is engineered for a high-performance, AI-driven PDF learning environment. It targets academic researchers, legal professionals, and technical students who require a tool that feels as precise as it is powerful.

The aesthetic is **Corporate Modern with a Cinematic Edge**. It leverages deep obsidian tones and structured layouts to evoke authority and focus. By blending high-contrast gold accents with a dark mode default, the system creates a focused "cockpit" experience for document analysis. The visual narrative balances the weight of traditional institutional reliability with the kinetic energy of cutting-edge artificial intelligence.

## Colors
The palette is built on a "Dark Industrial" foundation. The primary background uses a near-black neutral to minimize eye strain during long reading sessions. 

- **Primary Gold:** Used sparingly for high-value actions, AI-generated insights, and critical highlights. It represents the "value" extracted from documents.
- **Surface Tiers:** Three levels of gray distinguish the UI hierarchy. The darkest is the base; lighter grays define sidebar containers and cards.
- **Semantic Colors:** Success and Error states should be muted but distinct, ensuring they do not compete with the primary gold call-to-actions.

## Typography
The typography strategy prioritizes legibility and technical precision.

- **Headlines:** Use **Hanken Grotesk** for a sharp, contemporary feel. Tight letter-spacing and heavy weights are preferred for main section headers to mirror the bold corporate style of the reference.
- **Body:** **Inter** provides maximum readability for long-form PDF text and AI chat responses. 
- **Technical Metadata:** **JetBrains Mono** is used for "AI Thinking" states, citations, and metadata to reinforce the sense of technological processing.
- **Scale:** High contrast in size between display text and body copy is encouraged to maintain a structured information hierarchy.

## Layout & Spacing
This design system utilizes a **Fixed Grid** philosophy for dashboard views to maintain a structured, professional workspace, while employing a **Fluid Grid** for landing and marketing pages.

- **Desktop Dashboard:** 12-column grid. Left sidebar (2 cols), Center PDF Viewer (6 cols), Right AI Assistant (4 cols).
- **Gaps:** Generous 24px gutters ensure that dense information-heavy interfaces feel breathable.
- **Rhythm:** All spacing is derived from an 8px base unit. 
- **Mobile Reflow:** On mobile, the AI Assistant collapses into a floating action button or bottom drawer to maximize PDF visibility.

## Elevation & Depth
Depth in this system is created through **Tonal Layering** rather than traditional shadows.

- **Base Level:** The darkest neutral (#0F0F0F) is the canvas.
- **Mid Level:** Active workspaces and sidebar containers use a slightly lighter gray (#1A1A1A) with a thin, 1px low-contrast border (#2D2D2D).
- **High Level:** Modals and tooltips utilize a subtle glassmorphic effect (15px blur) with a 10% white opacity tint to appear as if they are floating above the document.
- **Interactions:** Hover states should involve a slight "glow" from the primary gold rather than a lift in Y-axis elevation.

## Shapes
The shape language is disciplined and architectural. 

A **Soft (0.25rem)** corner radius is the standard across the design system. This maintains a professional, serious tone while removing the harshness of purely sharp corners. 
- **Large Components:** Cards and main containers use a 0.5rem (rounded-lg) radius.
- **Interactive Elements:** Buttons and input fields strictly follow the 0.25rem rule to maintain a consistent "blocked" look.
- **Exceptions:** No pill-shaped elements are permitted; even buttons should feel like solid, structural blocks.

## Components
- **Buttons:** Primary buttons are solid Gold with black text. Secondary buttons are outlined in 1px gray with a subtle hover glow.
- **Input Fields:** Dark background, 1px border. On focus, the border transitions to Gold. Labels use the Monospaced font for a "terminal" feel.
- **AI Chat Bubbles:** The AI's responses are framed in a subtle gray container to distinguish them from user prompts, which remain plain text.
- **Chips/Tags:** Used for PDF categories or keywords. Use a "ghost" style—no fill, just a thin gray border and small monospaced text.
- **Cards:** Used for document libraries. Cards should feature a clear "thumbnail" area with a Gold progress bar indicating reading completion.
- **Status Indicators:** Use a pulse animation in the Primary Gold color to indicate "AI is analyzing" or "Processing document."