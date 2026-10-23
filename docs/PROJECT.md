# WITLAB
## Product Definition, Technical Architecture, UX/UI Specification & Incremental Build Plan

**Document type:** Foundational project specification  
**Project:** WitLab  
**Status:** New project — foundation to be built from scratch  
**Primary objective:** Build a modular, source-grounded learning application that converts learning material into editable flashcards and uses active recall, conceptual relationships, explanation, application, and spaced review to help learners develop and retain knowledge.

---

# 1. Executive Summary

WitLab is a learning application that helps people turn their own learning materials into structured, reusable study experiences.

A learner should be able to import a PDF or paste text, inspect the extracted content, choose the concepts or sections they want to study, generate candidate flashcards, review and approve those cards, organise them into decks, and practise them through different learning modes.

WitLab must evaluate the learner's answers independently of the learner's confidence, explain mistakes, record evidence of learning, and schedule appropriate future reviews.

The application must support general learning rather than being tied to one certification, institution, subject, or course.

The initial product will focus on a coherent end-to-end workflow rather than a large catalogue of features.

## Core product principle

**Turn learning material into knowledge that can be retrieved, connected, explained, applied, and revisited.**

The application must be simple to use without being simplistic in its learning logic.

The underlying system should be modular enough to support new subjects, document formats, evaluation methods, and learning activities without requiring a rewrite of the entire application.

# 2. Problem Statement

Traditional notes and study materials often leave learners with large amounts of information but little structure for practising retrieval, checking understanding, identifying misconceptions, or revisiting knowledge systematically.

Conventional flashcard applications can help with memorisation but may not adequately support relationships between concepts, explanations in the learner's own words, or practical application.

WitLab addresses this problem by combining:

- Source-grounded learning content.
- AI-assisted creation of candidate study cards.
- Human review and approval of generated material.
- Multiple deliberate learning modes.
- Independent answer evaluation.
- Explanatory feedback and correction.
- Evidence-based review scheduling.
- Editable, reusable study decks.

The objective is not to generate as many cards as possible. It is to create useful learning activities that help the learner understand and retain the material.

# 3. Product Scope

## 3.1 What WitLab is

WitLab is a general-purpose, source-grounded flashcard and active-recall learning application.

It consists of four connected capabilities:

1. **Import:** Bring learning material into the application.
2. **Transform:** Convert selected material into candidate study cards.
3. **Learn:** Practise retrieval, relationships, explanations, and applications.
4. **Improve:** Evaluate responses, correct misconceptions, record learning evidence, and schedule reviews.

## 3.2 What WitLab is not

The initial product is not:

- An Azure certification application.
- A course marketplace.
- A learning management system for institutions.
- A generic chatbot that happens to remember study sessions.
- A document editor intended to replace the original learning material.
- An unrestricted AI content generator that publishes unverified cards automatically.
- A collection of unrelated study games.
- A complex analytics platform that requires extensive data before it becomes useful.

AZ-900 content must not be hardcoded into the application. Azure is simply one possible subject a learner may import later.

## 3.3 Initial scope

The first functional product must support:

- Sources and editable decks.
- Text import and a real PDF-import pipeline.
- Document structure extraction where available.
- Selection of chapters, sections, or page ranges.
- AI-assisted generation of candidate cards.
- Draft review, editing, approval, and rejection.
- Multiple study modes.
- Deterministic and AI-assisted answer evaluation.
- Learning evidence and review scheduling.
- A useful dashboard and library.
- Profile and settings appropriate to the actual capabilities.
- Responsive, accessible, reusable UI components.
- Persistent data and appropriate ownership controls.

Core study activities must remain usable when AI services are unavailable. AI-dependent generation and open-ended evaluation must handle provider failures explicitly.

# 4. Product Model: Sources, Cards, and Decks

The relationship between source material and study cards is fundamental to WitLab.

## 4.1 Sources

A source represents the original learning material from which knowledge is extracted.

Examples include:

- A PDF document.
- Pasted text.
- Other document formats supported in future iterations.

A source should preserve, where available:

- Title and source type.
- Original file or stored content reference.
- Extracted text.
- Document structure.
- Page and section references.
- Import and processing status.
- Creation and update timestamps.
- Ownership information.
- Processing or extraction errors.

A source is not a flashcard deck. It is the evidence from which cards may be created.

## 4.2 Cards

A card represents a specific learning objective.

A card should support, as appropriate:

- A prompt or question.
- An expected answer or answer criteria.
- A card type.
- The relevant learning mode or modes.
- Source references.
- Evaluation criteria or a rubric.
- Draft or approved status.
- Revision history where appropriate.
- Associated concept or topic information.

Cards should be editable and reusable. Their source provenance should not be lost when they are added to another deck.

## 4.3 Decks

A deck is an organised collection of approved cards used for studying.

A deck should have:

- A title.
- An optional description.
- Its approved cards.
- Creation and update timestamps.
- Ownership information.
- Useful organisation and search metadata.

A deck can contain cards derived from multiple sources. A source can produce cards for multiple decks.

Do not duplicate the entire source document whenever a card is reused in another deck.

## 4.4 Drafts and approval

Generated cards must enter a draft state.

The learner must be able to:

- Preview a candidate card.
- Inspect its answer and source evidence.
- Edit its prompt and answer.
- Review its evaluation criteria where relevant.
- Approve it.
- Reject or discard it.

Only approved cards may enter normal study sessions.

Approval status must be enforced by backend business logic, not merely by hiding drafts in the frontend.

# 5. Primary User Journeys

## 5.1 First-time learner

1. The learner opens WitLab.
2. The learner understands what the application does.
3. The learner creates an account or signs in if authentication is required.
4. The learner reaches a useful home screen.
5. The learner chooses to create study material, explore available collections, or begin with an existing deck.
6. The learner can complete a meaningful first learning activity without navigating through unnecessary configuration pages.

Do not require a learner to choose Azure or another predefined subject before using the application.

## 5.2 Create a study deck from a PDF

1. The learner chooses **Create**.
2. The learner uploads a supported PDF or selects the paste-text alternative.
3. WitLab validates the input.
4. The system extracts text and available document structure.
5. The learner inspects detected chapters, sections, and page ranges.
6. The learner chooses what to study.
7. The learner selects appropriate generation preferences.
8. WitLab generates candidate cards grounded in the selected material.
9. The learner reviews, edits, approves, or discards the drafts.
10. The learner creates or selects a deck.
11. Approved cards become available for studying.

The application should automate technical steps that do not require a learner decision.

The learner should not need to understand database entities or manually orchestrate the creation of a source and deck in a prescribed technical sequence.

## 5.3 Study an existing deck

1. The learner opens a deck.
2. The learner sees its title, description, and useful information about its contents.
3. The learner chooses a study mode.
4. WitLab presents a suitable learning activity.
5. The learner responds.
6. The evaluator assesses the response independently of confidence.
7. The learner receives a result and useful feedback.
8. The learner corrects misunderstandings where needed.
9. WitLab records the result and schedules appropriate future review.
10. The learner continues or finishes the session.

## 5.4 Returning learner

A returning learner should be able to:

- Resume an interrupted session where supported.
- Continue a recent deck.
- Review due cards.
- Create a new deck.
- Find existing sources and decks.
- Inspect meaningful learning progress.

Do not fabricate recommendations, review counts, progress scores, or learning history.

# 6. Navigation and Screen Architecture

The navigation should reflect the learner's tasks rather than expose every technical capability as a separate destination.

## Primary navigation

### Home

A concise starting point answering:

- What can I study now?
- What should I revisit?
- How can I create new study material?

Prioritise the next useful action, not decorative analytics.

### Study / Review

Provide access to study sessions and cards that are due for review.

The interface should explain why a card is being revisited where useful.

Review must use the same underlying learning engine as ordinary study, not a disconnected second system.

### Create

The entry point for importing material and creating candidate study cards.

Provide PDF import and pasted text as appropriate. Pasted text is an alternative input method, not a substitute for the planned PDF workflow.

### Library

The place to find and manage:

- Sources.
- Editable decks.
- Available published collections.

Clearly distinguish original material from study decks without forcing users to understand the internal data model.

### Progress

Show evidence of learning rather than arbitrary engagement metrics.

Possible dimensions include recall, conceptual relationships, explanation, and application. Only show a dimension when sufficient meaningful evidence exists.

### Profile and Settings

Provide access to the learner's account and relevant preferences.

These may be separate screens or a compact account area, depending on actual functionality. Do not create a substantial page merely to expose one trivial field.

## Screen inventory

The application should cover the following screens or equivalent interface states:

1. Welcome and initial entry.
2. Sign-in and account creation, if required.
3. Home/dashboard.
4. Library.
5. Source details.
6. Deck details.
7. Collection discovery, when collections exist.
8. Material import.
9. Document processing.
10. Document structure and scope selection.
11. Generation settings.
12. Generation progress and errors.
13. Draft review and editing.
14. Deck creation and editing.
15. Study-mode selection.
16. Active study card.
17. Answer submission and evaluation.
18. Explanation and correction.
19. Session summary.
20. Review queue.
21. Learning progress.
22. Profile.
23. Settings.
24. Empty, loading, error, paused, and recovery states.

Not every item requires a separate route. Choose the presentation that best supports the task.

# 7. Learning Modes

WitLab must offer explicit, understandable learning modes.

## 7.1 Recall

Purpose: Retrieve facts, definitions, terminology, principles, and other appropriate knowledge from memory.

Suitable activities include:

- Term and definition retrieval.
- Short-answer questions.
- Factual questions.
- Multiple-choice questions where appropriate.

## 7.2 Connections

Purpose: Understand relationships between concepts.

Suitable activities include:

- Explain how two concepts relate.
- Compare and contrast concepts.
- Identify dependencies.
- Explain why a relationship matters.
- Distinguish similar concepts.

## 7.3 Explain

Purpose: Express conceptual understanding in the learner's own words.

The evaluator should assess the substance of the response rather than exact wording alone.

## 7.4 Apply

Purpose: Use knowledge in a scenario, solve a problem, or reason through an implementation.

Activities should require the learner to use the underlying concept rather than simply repeat a definition.

## 7.5 Hybrid

Purpose: Combine appropriate learning modes in a deliberate sequence.

Hybrid must not be an uncontrolled mixture of unrelated question types.

Its sequence should have a clear pedagogical rationale. For example, the learner may retrieve a concept, explain its relationship to another concept, and then apply it in a scenario.

The system should select activities appropriate to the card, learning objective, and available evaluation criteria.

## Important distinction

A **card type** describes the form of a question or task.

A **study mode** describes the kind of learning activity the learner is undertaking.

A **review schedule** determines when previously studied material should be revisited.

These concepts must remain distinct in the domain model and user interface.

The learner should understand which mode is active. The application must not unexpectedly switch modes during a session.

# 8. Answer Evaluation and Feedback

WitLab must distinguish confidence from correctness.

A learner may be confident and wrong, or uncertain and correct. Confidence can be recorded as supplementary evidence, but it must not determine the correctness verdict.

## 8.1 Deterministic evaluation

Use deterministic rules where answers have clear, reliable evaluation criteria.

Examples include:

- Multiple-choice selection.
- Exact terminology where appropriate.
- Numeric answers with defined tolerances.
- Structured answers with explicit validation rules.

Evaluation rules must be suitable for the particular answer type.

## 8.2 AI-assisted evaluation

Use AI assistance where semantic interpretation is necessary, particularly for:

- Open-ended explanations.
- Conceptual relationships.
- Application scenarios.
- Answers that may be correct despite different wording.

AI-assisted evaluation must use explicit criteria or rubrics and relevant source evidence wherever available.

The system should be capable of distinguishing:

- Correct.
- Partially correct.
- Incorrect.
- Ambiguous or requiring clarification.
- Not evaluated because evaluation failed.

Use only the result states that can be supported by the actual implementation.

## 8.3 Feedback

Feedback should tell the learner:

- What they understood correctly.
- What was missing or incorrect.
- Why the distinction matters.
- What a stronger answer would include.
- What misconception needs correction.

Avoid feedback that simply says "Wrong" or "Correct" when a more informative explanation is appropriate.

For example, if a learner explains that availability zones improve resilience because a failure in one zone need not take down another, the evaluator should recognise the core idea.

If the learner claims that availability zones alone protect against every regional outage, the evaluator should identify the limitation rather than approving the answer based on a few matching keywords.

## 8.4 AI failure handling

AI evaluation may fail because of timeouts, provider outages, invalid output, or missing configuration.

In those cases:

- Preserve the learner's submitted answer.
- Explain that evaluation could not be completed.
- Offer a safe retry or another appropriate action.
- Use a deterministic fallback only when it is valid for that answer type.
- Never silently label an unevaluated answer correct.
- Never invent evaluation results.

The core learning loop must not depend on the availability of an AI provider.

# 9. PDF and Text Processing Pipeline

Document processing is a major product capability and must be designed as a pipeline rather than embedded inside a UI component.

## Stage 1: Import

Accept supported PDFs and pasted text.

Validate format, size, and input integrity.

Persist the source and track its processing status.

## Stage 2: Extraction

For PDFs, use a real text-extraction implementation.

Extract page boundaries and document structure where available.

Scanned documents may require OCR. Do not assume that every PDF contains extractable text.

If OCR is not implemented, report that limitation clearly rather than fabricating extracted content.

## Stage 3: Structure identification

Identify chapters, headings, sections, and subsections when supported by the document.

If the structure is uncertain, show the extracted text and available page ranges and allow a reasonable fallback.

Do not invent chapter boundaries.

## Stage 4: Scope selection

Allow the learner to select:

- The entire document.
- Specific chapters or sections.
- A custom page range.
- A topic or learning objective, where supported.

Show the selection before generation begins.

## Stage 5: Candidate generation

Generate candidate cards grounded in the selected source material.

Cards should be clear, answerable, appropriately contextualised, and useful for the intended learning mode.

Avoid duplicates, trivial fragments, ambiguous questions, and unsupported claims.

## Stage 6: Validation

Validate the structure of generated results.

Check required fields, source references, duplicates, and other appropriate quality constraints.

Do not assume that syntactically valid AI output is factually correct.

## Stage 7: Draft review

Present candidate cards for learner review.

Show source evidence where possible.

Allow editing, approval, and rejection.

## Stage 8: Publication

Only approved cards may enter the study deck.

Maintain the association between cards and their sources.

## Stage 9: Study

Use the same study engine, evaluation, evidence recording, and scheduling mechanisms used by all other approved cards.

Imported material must not require a separate learning engine.

# 10. AI Integration and Cost Control

AI is an optional external capability, not a requirement for every operation.

The application should work without AI for:

- Navigating the library.
- Opening and editing existing cards.
- Studying approved cards.
- Evaluating supported objective answers.
- Recording responses.
- Scheduling reviews.
- Viewing existing progress.

AI may be used for:

- Generating candidate cards.
- Interpreting open-ended responses.
- Producing explanatory feedback.
- Identifying conceptual relationships when appropriate.

Keep the AI integration behind a backend service interface so the rest of the application does not depend directly on one provider's API.

Never expose secret API keys in frontend code.

Use environment variables for credentials. Validate AI outputs and handle failures.

Record sufficient evaluation metadata for debugging and reproducibility without unnecessarily storing sensitive information.

Control cost through appropriate model selection, bounded inputs and outputs, request limits, and reuse of previously extracted or generated results where appropriate.

Do not make unsupported assumptions about free API access. Provider pricing and available models must be verified when the integration is configured.

# 11. Review Scheduling and Learning Evidence

WitLab must record meaningful learning evidence and use it to support future reviews.

The initial implementation should use a transparent, deterministic scheduling strategy rather than an unnecessarily complex adaptive algorithm.

The scheduler should consider appropriate evidence such as:

- Whether the answer was correct.
- Whether it was partially correct.
- The card's previous review history.
- Time since the previous review.
- Other relevant signals supported by the chosen algorithm.

Confidence may be recorded, but it must not override correctness.

Keep scheduling logic separate from the UI and AI evaluator.

The application should be able to explain why a card is due for review at a useful level of detail.

Progress must not confuse:

- A card that has never been practised.
- A card that has been practised but answered incorrectly.
- A card that has been answered correctly.
- A card that has been consistently recalled over time.

Do not claim that one correct answer proves long-term retention.

# 12. UX/UI and Design System

The application must have a coherent, deliberate visual system.

Do not build a set of unrelated screens that merely share a navigation bar.

## 12.1 Design principles

- Clear hierarchy.
- Minimal unnecessary decisions.
- Consistent spacing and typography.
- Restrained, purposeful colour.
- Responsive layouts.
- Accessible contrast and keyboard navigation.
- Visible focus states.
- Helpful feedback.
- Predictable interactions.
- Meaningful empty states.
- Clear distinction between drafts and approved content.

The interface should prioritise the learning task over decorative analytics or excessive explanatory copy.

## 12.2 Reusable components

Create shared components where they genuinely reduce duplication and improve consistency.

Examples include:

- Application layout.
- Desktop sidebar and mobile navigation.
- Page headers.
- Buttons and form controls.
- Source and deck items.
- Search and filter controls.
- Flashcard presentation.
- Answer inputs.
- Evaluation feedback.
- Draft-review controls.
- Dialogs and drawers.
- Loading indicators.
- Empty states.
- Error messages.
- Progress visualisations.

Do not force unrelated functionality into a single generic component merely because its visual appearance is similar.

## 12.3 Design tokens

Centralise shared visual values using the existing styling system.

Define reusable tokens for:

- Colours.
- Typography.
- Spacing.
- Borders and radii.
- Shadows.
- Responsive breakpoints.
- Focus, hover, active, disabled, loading, success, and error states.

Changing a shared design token should update its intended uses throughout the application.

## 12.4 Interaction patterns

Use interaction patterns according to purpose:

- Dropdowns for compact choices.
- Segmented controls for a small set of mutually exclusive options.
- Checkboxes for independent multiple selections.
- Popovers for lightweight contextual information.
- Drawers for secondary editing that should preserve the current context.
- Dedicated screens for complex tasks such as reviewing many generated cards.
- Confirmation dialogs for consequential destructive actions.

Do not use modals and dropdowns indiscriminately.

Do not interrupt an active recall task with unnecessary interface changes.

## 12.5 Screen-level design quality

Every screen must have:

- A clear purpose.
- A visible primary action.
- Appropriate secondary actions.
- Consistent hierarchy.
- Useful loading and error states.
- No decorative controls that do nothing.
- No fabricated data.
- Responsive behaviour.

A screen inventory is not a substitute for implementing the actual screens.

# 13. Profile, Settings, and Progress

## Profile

Profile should contain meaningful account information and appropriate learning preferences.

Potential fields include a display name, optional profile image, and optional learning interests or goals.

Do not create a large profile page solely to expose a single trivial field. Use a compact account area if that is more appropriate.

## Settings

Settings should contain genuine user preferences and account controls that the application actually supports.

Possible settings include study preferences, accessibility, notifications, and account management.

AI evaluation choices should be explained in the relevant study context. Advanced controls should not overwhelm the learner.

Do not expose internal technical implementation details, such as browser-session persistence, as prominent product features unless the user needs to understand them to make an informed choice.

## Progress

Progress should display meaningful learning evidence, not generic dashboard decoration.

Do not show a skill score without defining what it measures.

Do not label a skill as developing merely because the learner has interacted with a related card.

The presentation must reflect the available evidence and communicate its limitations.

# 14. Technical Architecture

## 14.1 Required stack

Use a small, understandable TypeScript application architecture:

- Frontend: React, TypeScript, and Vite.
- Backend: Node.js, Express, and TypeScript.
- Database: PostgreSQL.
- Database access: the existing `pg` approach or an equivalent deliberately selected data-access layer.
- Validation: Zod where appropriate.
- Version control: Git.
- Package management: npm workspaces if used by the chosen repository structure.

The browser must never connect directly to PostgreSQL.

All database operations must pass through the backend.

Keep the application suitable for local development on Windows using PowerShell.

Do not introduce microservices, message brokers, cloud infrastructure, or a complex deployment architecture unless a demonstrated requirement justifies them.

## 14.2 Architectural boundaries

The system should have the following logical layers:

1. Frontend presentation and interactions.
2. Frontend API client.
3. Backend routes and request validation.
4. Backend application services.
5. Domain logic for cards, evaluation, study, and scheduling.
6. External integrations for AI and document processing.
7. Database repositories and persistence.
8. PostgreSQL schema and migrations.

Keep presentation logic separate from learning logic.

Keep AI provider-specific code behind an interface.

Keep the scheduler independent of the frontend and AI evaluator.

Do not duplicate business rules across frontend components and backend routes.

## 14.3 Authentication and ownership

User-owned sources, decks, and study records must be protected by backend authorisation.

The backend must verify ownership when reading, updating, deleting, or using user-owned records. Changing an identifier in an API request must not grant access to another user's data.

If authentication is not yet implemented, build the product in a way that can support it without pretending ownership protection is complete.

Keep the initial authentication design proportionate to the product. Do not introduce an elaborate identity system merely for architectural sophistication.

# 15. Proposed Repository Folder Structure

Use a simple monorepo with a frontend, backend, shared contracts, and project documentation.

```text
witlab/
│
├── README.md
├── package.json
├── package-lock.json
├── .gitignore
├── .env.example
│
├── docs/
│   ├── PROJECT.md
│   ├── ARCHITECTURE.md
│   ├── DATA_MODEL.md
│   ├── LEARNING_ENGINE.md
│   ├── UX_UI.md
│   ├── API_CONTRACTS.md
│   └── BUILD_PLAN.md
│
├── apps/
│   │
│   ├── web/
│   │   ├── package.json
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── app/
│   │       │   ├── App.tsx
│   │       │   ├── router.tsx
│   │       │   └── providers/
│   │       │
│   │       ├── pages/
│   │       │   ├── HomePage.tsx
│   │       │   ├── LibraryPage.tsx
│   │       │   ├── CreatePage.tsx
│   │       │   ├── SourcePage.tsx
│   │       │   ├── DeckPage.tsx
│   │       │   ├── StudyPage.tsx
│   │       │   ├── ReviewPage.tsx
│   │       │   ├── ProgressPage.tsx
│   │       │   ├── ProfilePage.tsx
│   │       │   └── SettingsPage.tsx
│   │       │
│   │       ├── components/
│   │       │   ├── ui/
│   │       │   ├── layout/
│   │       │   └── feedback/
│   │       │
│   │       ├── features/
│   │       │   ├── sources/
│   │       │   │   ├── components/
│   │       │   │   ├── hooks/
│   │       │   │   └── api.ts
│   │       │   ├── decks/
│   │       │   │   ├── components/
│   │       │   │   ├── hooks/
│   │       │   │   └── api.ts
│   │       │   ├── generation/
│   │       │   │   ├── components/
│   │       │   │   ├── hooks/
│   │       │   │   └── api.ts
│   │       │   ├── study/
│   │       │   │   ├── components/
│   │       │   │   ├── hooks/
│   │       │   │   └── api.ts
│   │       │   ├── review/
│   │       │   ├── progress/
│   │       │   └── account/
│   │       │
│   │       ├── services/
│   │       │   └── apiClient.ts
│   │       │
│   │       ├── styles/
│   │       │   ├── tokens.css
│   │       │   ├── global.css
│   │       │   └── utilities.css
│   │       │
│   │       ├── types/
│   │       └── main.tsx
│   │
│   └── api/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── app.ts
│           ├── server.ts
│           │
│           ├── config/
│           ├── routes/
│           ├── middleware/
│           ├── validators/
│           │
│           ├── modules/
│           │   ├── sources/
│           │   │   ├── source.routes.ts
│           │   │   ├── source.service.ts
│           │   │   ├── source.repository.ts
│           │   │   └── source.schema.ts
│           │   │
│           │   ├── documents/
│           │   │   ├── extraction.service.ts
│           │   │   ├── structure.service.ts
│           │   │   └── document.types.ts
│           │   │
│           │   ├── decks/
│           │   ├── cards/
│           │   ├── generation/
│           │   ├── study/
│           │   ├── evaluation/
│           │   ├── scheduling/
│           │   ├── progress/
│           │   └── users/
│           │
│           ├── integrations/
│           │   ├── ai/
│           │   │   ├── ai.provider.ts
│           │   │   ├── ai.service.ts
│           │   │   └── ai.schemas.ts
│           │   └── documents/
│           │
│           ├── db/
│           │   ├── pool.ts
│           │   ├── migrations/
│           │   └── seeds/
│           │
│           └── utils/
│
├── packages/
│   └── contracts/
│       ├── package.json
│       └── src/
│           ├── sources.ts
│           ├── decks.ts
│           ├── cards.ts
│           ├── study.ts
│           └── index.ts
│
└── tests/
    ├── integration/
    └── e2e/
```

## Folder structure rules

This structure is the intended starting architecture, not a requirement to create every empty directory immediately.

Create folders and files as their corresponding functionality is implemented.

Keep each module proportionate. Small features do not need dozens of files.

The frontend should organise reusable presentation components separately from feature-specific components.

The backend should group related routes, services, repositories, and validation by domain.

Shared contracts should contain types or schemas that genuinely need to be shared between frontend and backend. Do not duplicate entire domain implementations in the shared package.

Database migrations must be versioned and applied incrementally.

Tests should be located near the code or in the dedicated test folders according to a consistent project convention.

Do not introduce duplicate `types`, `utils`, or `services` directories simply because a template contains them. Each directory must have a clear responsibility.

## File responsibilities

- `docs/PROJECT.md`: This complete product specification.
- `docs/ARCHITECTURE.md`: Technical boundaries and dependencies.
- `docs/DATA_MODEL.md`: Entities, relationships, persistence, and migration decisions.
- `docs/LEARNING_ENGINE.md`: Learning modes, evaluation, evidence, and scheduling.
- `docs/UX_UI.md`: Navigation, screen behaviour, interaction patterns, and design system.
- `docs/API_CONTRACTS.md`: Backend endpoints and request/response contracts.
- `docs/BUILD_PLAN.md`: Incremental build order and acceptance criteria.
- `apps/web/src/components/ui/`: Reusable visual primitives.
- `apps/web/src/components/layout/`: Application shell and navigation.
- `apps/web/src/features/`: Frontend functionality grouped by product feature.
- `apps/api/src/modules/`: Backend domain modules.
- `apps/api/src/integrations/`: External AI and document-processing integrations.
- `apps/api/src/db/migrations/`: Version-controlled database changes.
- `packages/contracts/`: Shared request, response, and domain contracts where appropriate.

# 16. Initial Data Model

Design the schema to support the product without prematurely implementing unnecessary complexity.

The principal entities are:

- User.
- Source.
- Document processing job or processing status.
- Deck.
- Card.
- Deck-card association where needed.
- Card-source association or source evidence.
- Evaluation criteria or rubric where needed.
- Study session.
- Study response.
- Review schedule.
- Learning evidence.
- User preferences.

The final schema must reflect the actual relationships and required persistence.

Use stable identifiers, appropriate foreign keys, timestamps, and constraints.

Draft and approved content must be distinguishable.

A card's inclusion in a deck must not destroy its provenance.

Store original material and extracted content according to a clear retention policy. Avoid unnecessary duplication of large document contents.

Do not create a separate database table for every conceptual label without a concrete requirement.

Before implementing migrations, document the entity relationships and important constraints.

# 17. Incremental Build Plan

Build WitLab in small, verifiable batches.

Each batch must establish a working foundation for the next one. Do not create every page and service as an empty placeholder in the first batch.

## Batch 1 — Foundation and application shell

Build:

- Repository and workspace setup.
- React, TypeScript, and Vite frontend.
- Express and TypeScript backend.
- PostgreSQL connection configuration.
- Environment-variable handling.
- Health-check endpoint.
- Frontend-to-backend API connection.
- Basic application layout.
- Reusable design tokens and initial UI primitives.
- Error handling and basic tests.

Acceptance criteria:

- The frontend runs.
- The backend runs.
- The frontend can communicate with the backend.
- PostgreSQL connectivity can be verified.
- Environment secrets are not committed.
- The application has a clear, reusable structural foundation.

Do not build the complete product UI in this batch.

## Batch 2 — Data model and persistence

Build:

- Initial schema and migrations.
- Core source, deck, and card persistence.
- Appropriate ownership fields and constraints.
- Source and deck CRUD operations.
- Validation and API contracts.
- Repository and service boundaries.
- Tests for persistence and validation.

Acceptance criteria:

- Sources and decks can be created and retrieved through the backend.
- Data persists in PostgreSQL.
- Invalid requests are handled explicitly.
- Relationships are enforced appropriately.
- The schema supports future card approval and source provenance.

## Batch 3 — Core learning engine

Build:

- Approved-card retrieval.
- Study sessions.
- Answer submission.
- Deterministic evaluation for supported objective answers.
- Evaluation feedback.
- Response persistence.
- Learning evidence.
- Initial review scheduling.

Acceptance criteria:

- A learner can complete a study session using real persisted cards.
- Confidence is not treated as correctness.
- Answers are evaluated using the appropriate method.
- Feedback appears before the learner continues.
- Study responses persist.
- Due-review behaviour is deterministic and testable.

## Batch 4 — Sources, document extraction, and generation

Build:

- Pasted-text import.
- Real PDF text extraction.
- Processing status and error handling.
- Document structure identification where supported.
- Chapter, section, or page-range selection.
- AI integration behind a backend service interface.
- Candidate-card generation.
- Candidate validation.
- Source provenance.

Acceptance criteria:

- The learner can import supported material.
- Extracted content is genuine.
- The learner can inspect and select the learning scope.
- Candidate cards are grounded in the selected content.
- Unsupported document types and processing failures are handled honestly.
- AI failure does not corrupt stored source material.

OCR for scanned documents should be implemented only when deliberately included in scope and supported by a real integration.

## Batch 5 — Draft approval and deck management

Build:

- Draft-card review.
- Editing and rejection.
- Explicit approval.
- Deck creation and editing.
- Adding approved cards to decks.
- Source inspection.
- Appropriate persistence and ownership checks.

Acceptance criteria:

- Generated cards cannot bypass the approval process.
- Drafts are not available in ordinary study sessions.
- Approved cards can be reused appropriately.
- Source provenance remains available.
- Decks can be managed without duplicating the learning engine.

## Batch 6 — Complete learner experience and adaptive behaviour

Build and refine:

- Dashboard.
- Library and discovery.
- Study-mode selection.
- Recall, Connections, Explain, Apply, and Hybrid experiences.
- Review experience.
- Progress visualisation based on actual evidence.
- Profile and Settings.
- Responsive layouts.
- Reusable UI patterns across all screens.
- Appropriate adaptation to review evidence.

Acceptance criteria:

- A new learner has a clear starting path.
- A returning learner can resume useful activities.
- Learning modes behave deliberately.
- The interface is consistent, accessible, and responsive.
- Progress displays genuine learning evidence.
- Profile and Settings contain meaningful functionality.
- The application remains coherent across the full learning journey.

## Batch 7 — Integration hardening and release readiness

Build:

- End-to-end regression coverage.
- Input and API security checks.
- Ownership and access-control verification.
- Failure and recovery testing.
- Database integrity checks.
- Performance checks appropriate to the application.
- Configuration and setup documentation.
- Final verification of the complete learning journey.

Do not begin this batch until the preceding functionality has been implemented and verified.

# 18. Development Rules for Every Batch

These rules apply throughout the project.

1. Read the current project documentation before modifying the code.
2. Inspect the existing files and relevant dependencies before proposing changes.
3. Implement only the current batch's scope and its necessary prerequisites.
4. Provide complete files or precise, clearly scoped patches—not disconnected code fragments.
5. Include exact PowerShell commands for setup, migrations, running the application, and verification when relevant.
6. Explain where each new file belongs and why it exists.
7. Preserve established folder structure, API contracts, schema decisions, and design tokens unless a justified change is required.
8. Do not silently modify unrelated functionality.
9. Do not claim that tests passed unless they were actually run.
10. Do not replace real functionality with mock responses or placeholder success states.
11. Do not introduce unnecessary dependencies or abstractions.
12. Keep the project runnable at the end of each batch.
13. Update documentation when an architectural decision changes.
14. Keep secrets in environment variables and provide an `.env.example` without real credentials.
15. Do not proceed to the next batch until the current batch's acceptance criteria have been checked.

When developing through Codex or another coding assistant, provide the implementation in coherent, reviewable increments so the learner can inspect the changes and copy the necessary code into the project or cloud workspace.

# 19. Testing Strategy

Testing must follow the development order.

## Unit tests

Test deterministic business logic, including:

- Validation.
- Objective answer evaluation.
- Scheduling calculations.
- Card-status transitions.
- Draft approval rules.

## Integration tests

Test interactions between:

- API routes and services.
- Services and PostgreSQL.
- Source import and document extraction.
- Card generation and validation.
- Study responses and persistence.
- Ownership checks and data access.

## End-to-end tests

Verify the complete learner journey:

Import material → inspect structure → select scope → generate drafts → review and approve → publish to a deck → select a study mode → answer a question → receive evaluation feedback → record evidence → revisit a card when due.

Also test interrupted workflows and failures.

A successful frontend build alone does not prove that the product works.

# 20. Security, Privacy, and Data Integrity

- Keep AI API keys on the backend.
- Validate all inputs.
- Enforce ownership and access control on the backend.
- Restrict upload types and sizes.
- Handle uploaded files safely.
- Prevent unauthorised access to source documents.
- Avoid exposing unnecessary personal or source content in logs.
- Preserve original source evidence.
- Prevent drafts from bypassing approval.
- Prevent failed AI operations from creating false learning records.
- Use database constraints and transactions where appropriate.
- Make data export or deletion behaviour explicit when account management is implemented.

Do not store more personal data than the product requires.

# 21. Definition of a Successful First Product

WitLab's first useful release is complete when a learner can:

1. Open the application and understand how to start.
2. Import a supported PDF or paste text.
3. Inspect the available document structure.
4. Select the material to study.
5. Generate candidate flashcards.
6. Review, edit, approve, and reject cards.
7. Organise approved cards into editable decks.
8. Study through deliberate learning modes.
9. Receive meaningful answer evaluation and correction.
10. Have responses and learning evidence recorded.
11. Revisit material according to a real review schedule.
12. Find sources, decks, and progress through a coherent interface.

The application must remain maintainable, modular, testable, and easy to extend.

The success criterion is not the number of routes, folders, or components. It is a functioning learning system with a clear product model and a reliable end-to-end user experience.

# 22. Final Instruction

Treat this document as the authoritative product specification for the new WitLab project.

Start with Batch 1 only.

Do not import the old project's assumptions, hardcoded Azure content, or unnecessary complexity. Do not create the entire application in one pass. Establish the foundation, verify it, and build upon it incrementally.

Every later batch must preserve the core principles defined here:

- Source-grounded learning.
- Editable and reusable cards.
- Explicit draft approval.
- Independent answer evaluation.
- Deliberate learning modes.
- Evidence-based review.
- Reusable UI components.
- Clear architectural boundaries.
- Honest failure handling.
- Incremental, verifiable development.

**Build the learning system first. Let the interface, AI capabilities, and additional features grow from that foundation.**