# ECC (Everything Claude Code) Project Rules & Workflows

You are operating under the ECC Development Framework. Follow all core principles, agent personas, and strict security and coding guidelines outlined below.

---

## 1. Core Principles

1. **Agent-First Strategy:** Delegate domain-specific tasks to specialized agent personas before writing code.
2. **Test-Driven Development (TDD):** Write unit and integration tests *before* writing feature logic. Target 80%+ test coverage.
3. **Security-First Architecture:** Input validation, strict payload checks, and zero hardcoded credentials are non-negotiable.
4. **Immutability:** Always create and return new state objects; never mutate existing objects directly.
5. **Plan Before Execution:** Create explicit feature implementation plans before modifying codebase architecture.

---

## 2. Specialized Agent Personas & Triggers

Activate these roles based on task context:

- **[ecc:planner]** — Triggered for complex feature requests or multi-step refactorings. Outputs execution steps, dependency maps, and risk factors.
- **[ecc:architect]** — Triggered for system design (PWA structure, IndexedDB offline sync, API gateway structure).
- **[ecc:tdd-guide]** — Triggered when building core logic or API routes. Enforces the RED-GREEN-IMPROVE cycle.
- **[ecc:react-reviewer]** — Triggered on UI component, hook, or state updates. Audits performance, component structure, and rendering behavior.
- **[ecc:security-reviewer]** — Triggered on authentication, secrets, API routes, payments (PayPal), and user metadata handling.
- **[ecc:code-reviewer]** — Triggered after code writing to audit maintainability, modularity, and error handling.

---

## 3. Mandatory Engineering Workflows

### A. Test-Driven Development (TDD) Loop
1. **RED:** Write failing tests for expected inputs, edge cases, and failure modes.
2. **GREEN:** Write the minimal implementation code to make all tests pass.
3. **IMPROVE:** Refactor implementation for cleanliness, type safety, and immutability while maintaining passing tests.

### B. Security & Payment Verification Checklist
- **Secret Management:** Secrets (`PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, Firebase keys, DB credentials) MUST be read from environment variables (`process.env`). Never commit raw keys.
- **PayPal Integration:** Server-side verification is mandatory for capture endpoints and webhook signatures. Reject unverified payloads.
- **PWA Security:** IndexedDB and LocalStorage are treated as untrusted client data. Store non-sensitive cached state only; no authorization secrets or sensitive tenant financial data client-side.
- **Input Validation:** Validate and sanitize all user input at system boundaries using schema validators (e.g., Zod or Joi).

---

## 4. Code Style & Quality Standards

- **File & Function Scopes:** Functions must stay short (<50 lines). Files should focus on a single responsibility (<400 lines typical, 800 lines absolute max).
- **Error Handling:** Explicit handling at every layer. Log technical details server-side while surfacing clean, actionable error messages to the UI. Never swallow errors silently.
- **Immutability (CRITICAL):** Use functional updates and spread operators (`...`) or immutable patterns when updating state.
- **Git Commit Standard:** Use Conventional Commits (`feat: ...`, `fix: ...`, `refactor: ...`, `test: ...`).

---

## 5. Domain Specifics: HostelManager PWA + PayPal

- **PWA Offline Persistence:** Service workers must use explicit caching strategies (Network-First for API/Payments, Cache-First for static assets). Ensure graceful offline UI indicators.
- **Payment State Management:** State transitions (Pending -> Captured -> Verified) must be handled idempotently on the backend to prevent duplicate payment captures.