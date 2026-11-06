# Dashboard design standards

Beadsmith should help people understand their work, choose an action, and
follow its outcome. Design around three principles: let the data determine
the presentation, reveal actions when they become relevant, and design every
interaction state with the same care as the resting screen.

These standards guide new and changed interfaces and their review. They are
requirements for design work, not a claim that every existing screen meets
them. The [product and security contract](contract.md) and
[architecture decisions](../specs/decisions/README.md) continue to govern
what the application can do.

## Let the data determine the presentation

### 1. Choose a view for the user's question

Identify the question a view answers before choosing its layout. Each summary,
column, and control should help answer that question or support the next action.

| User's question                   | Default presentation                        | Beadsmith example                                                         |
| --------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| How do these records compare?     | Table with consistent columns and sorting   | Compare issues by priority, status, assignee, and dependencies.           |
| What happened, and in what order? | Timeline or activity feed                   | Read issue events with their actor, action, and time.                     |
| Where is work in the workflow?    | Board grouped by meaningful state           | Scan open, blocked, and in-progress work.                                 |
| What should I work on next?       | Focused list or deck                        | Review ready issues with priority and enough context to choose.           |
| How is a measure changing?        | Chart with a defined measure and time range | Inspect issue throughput over time, when the underlying data supports it. |
| What does this one record mean?   | Detail pane or dedicated detail page        | Read an issue's description, comments, and relationships.                 |

These are defaults, not exclusive formats. A time-sorted table can still be
appropriate when comparing individual events matters more than their sequence.
Add a chart only when it answers a useful aggregate question. Label its units,
period, and scope, and make the values available as text or a table. Do not
imply a trend from a single snapshot or treat missing observations as zero.

### 2. Format fields according to their meaning

- **Text:** left-align text and give the primary identifying field enough
  space to distinguish records. Truncate secondary long text when necessary;
  provide a keyboard- and touch-accessible way to read the full value. Copy
  actions must copy the complete value.
- **Quantities:** right-align comparable numbers and their headers. Use
  tabular numerals, consistent precision, and explicit units where needed.
  Align decimal places for decimal comparisons. Issue IDs, dates, and priority
  codes are labels, not quantities to align by place value.
- **Categories:** use compact chips or badges for repeated, bounded values
  such as status and issue type. Reuse the same label and treatment everywhere.
  Free-form text does not need a chip simply because it fits inside one.
- **Time:** use consistent date and relative-time formats. Make exact time
  and timezone available when the distinction matters. State the ordering of
  event streams clearly.
- **People and agents:** retain a readable actor name. An avatar or marker
  may speed recognition, but must not be the only way to identify the actor.
- **Missing values:** distinguish unknown, unavailable, and not applicable
  from zero. Explain an ambiguous placeholder through a label or help text.
- **Inactive records:** reduce emphasis without making content unreadable
  or suggesting the row cannot be opened. Keep the status explicit; closed
  does not mean disabled.

Keep row structure stable as content changes. Prioritize identifying fields
and the user's current task at narrow widths; move secondary details into an
accessible detail view or deliberate table scroll area. Do not shrink the
whole interface until it fits.

### 3. Make color carry a consistent meaning

Use the semantic tokens in [`src/app.css`](../src/app.css). Status colors
describe status; they are not decoration for unrelated cards or columns.
The existing red accent also marks primary actions and selection, while
destructive and error treatments use the danger tokens. Distinguish those
roles with clear labels, icons, and placement rather than color alone.

Use neutral surfaces for structure and reserve strong emphasis for the
information or action that needs attention. Check text, badges, selection,
focus, and errors in both themes. Do not lower an entire row's opacity to
de-emphasize it if that makes its content or controls hard to read.

## Reveal actions when they become relevant

### 4. Match visibility to importance, frequency, and consequence

Give each task area a clear primary action. Keep common actions and information
needed for a decision visible. Place occasional actions near the object they
affect, and reveal fine-grained utilities in context.

| Visibility                         | Use it for                                          | Requirement                                                               |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| Always visible, with a label       | The main task, frequent actions, essential warnings | Make the next step clear without exploration.                             |
| Visible contextual control or menu | Occasional actions on an issue, row, or selection   | Use a recognizable trigger and name its scope.                            |
| Revealed on hover or focus         | Small utilities such as copying a value             | Provide equivalent keyboard and touch access without layout shift.        |
| Disclosed after an explicit action | Advanced options or a focused subtask               | Keep the route to them discoverable and preserve the surrounding context. |

Hover and swipe may be shortcuts; neither may be the only route to an action.
Hidden controls must become visible when keyboard focus reaches them, stay
usable while the pointer moves to them, and have a touch-accessible trigger.
Do not hide a required next step, an error, or a consequential choice in a
tooltip or an unlabeled icon.

### 5. Choose the smallest surface that supports the task

- **Inline:** show brief explanations, validation, and feedback beside the
  item concerned.
- **Tooltip:** explain a control or short ambiguous term. Keep it
  non-interactive.
- **Menu or popover:** offer a short set of actions or a small contextual
  task. Put the main input or action first.
- **Drawer or side pane:** support sustained inspection while keeping the
  list and selection in view.
- **Modal dialog:** focus attention on a bounded task or a confirmation that
  needs an explicit decision. Name the action and the affected object.
- **Dedicated page:** support a substantial workflow, independent navigation,
  or a detail view people need to revisit or share by URL.

Preserve filters, selection, scroll position, and unfinished input when a
temporary surface closes. Return focus to the trigger, or a sensible nearby
control if the trigger no longer exists. Use the shared primitives' focus
and dismissal behavior; avoid stacking dialogs for ordinary subtasks.

### 6. Sequence onboarding around useful work

Introduce the next useful action when it is available. Prefer an actionable
empty state or a short contextual cue to a modal explaining the whole product.
Reveal later steps after the relevant action, and allow guidance to be
dismissed and found again through help.

Onboarding must respect the person's role and the application's current state.
Do not direct a reader to launch an agent or present an unavailable action as
their next step. Feature announcements should explain the benefit, offer a
route to try it, and be dismissible without blocking ongoing work.

## Design the states beyond the resting screen

### 7. Specify the full interaction before calling it complete

For each interactive component, account for the states below that apply.
Review transitions as well as individual appearances.

| State                             | Required behavior                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Default                           | Make the content, available actions, and current selection understandable.                                        |
| Hover, focus, pressed, selected   | Provide distinct feedback and a visible keyboard focus indicator; keep layout stable.                             |
| Loading or refreshing             | Show what is pending. Retain useful existing content during refresh and identify stale data when relevant.        |
| First-use empty                   | Explain what belongs here and offer an appropriate next action.                                                   |
| No matching results               | Show the active constraints and a way to change or clear them.                                                    |
| Validation error                  | Identify the affected input, explain how to fix it, and preserve entered values.                                  |
| Request or connection failure     | Explain what failed and offer a meaningful recovery action. Never present failed reads as an empty dataset.       |
| Unavailable or restricted         | Explain the relevant limitation without inviting an action the user cannot perform or exposing protected details. |
| Submitting or running             | Acknowledge the action, prevent accidental duplicate submission, and show how to follow progress.                 |
| Success, failure, or cancellation | Report the observed outcome accurately and make the next step clear.                                              |

Disabled controls need an understandable reason that is available without
hovering a disabled element. Use inline explanations when they affect a
decision. Announce important asynchronous feedback to assistive technology
without moving focus unexpectedly.

### 8. Make hidden help discoverable and accessible

Every icon-only button needs an accessible name. Add a tooltip for an icon or
abbreviation whose visible meaning needs explanation, and show it on keyboard
focus as well as hover. Tooltips must be dismissible, remain available while
being read, and avoid covering the content or control they explain. A browser
`title` attribute alone is insufficient for help users need to complete a task.

Use a visible label or help text when understanding is required before acting.
If explanatory content contains links, buttons, or a longer decision, use an
appropriate interactive surface instead of a tooltip. Supplementary indicators
for comments, overflow, or additional details need a readable meaning and a
clear route to the content.

### 9. Report the outcome the application can actually verify

Match feedback to the operation. Copying a value can finish immediately;
launching an agent starts work whose result arrives later. Keep acknowledgment,
progress, and completion distinct in the language and visual treatment.

In Beadsmith, board movement requests agent work through a confirmation dialog.
The card stays in its source column until Beads reflects a change. A launch
confirmation must not claim the issue is already in progress or completed.
Follow [ADR-0006](../specs/decisions/0006-durable-agent-dispatch.md) and the
[dispatch contract](file-tackle-dispatch.md).

Brief success feedback may be transient. Errors that require action and
ongoing work need a persistent place to inspect them. Preserve user input on
failure, make retry behavior clear, and do not offer cancellation or undo unless
the underlying operation supports it.

## Apply the shared visual language

Use the existing typography, spacing, radii, surfaces, and semantic color tokens
in [`src/app.css`](../src/app.css). Use the interface font for controls and data
and the prose font for long-form reading. Reuse
[shared UI primitives](../src/lib/components/ui/) and domain components such as
[status badges](../src/lib/components/status-badge.svelte),
[priority chips](../src/lib/components/priority-chip.svelte), and
[empty states](../src/lib/components/empty-state.svelte).

Create hierarchy with grouping, alignment, spacing, and type before adding
another border, colored fill, or card. Dense layouts should reduce repetition
and disclose secondary detail while retaining readable text, usable targets,
and visible focus. Keep field labels in sentence case and action labels
specific: say what the action does and name the object when needed.

Shared components are the starting point for consistency. If a component does
not meet a required behavior, improve it and review its callers rather than
copying the limitation into another screen. Keep shortcut guidance consistent
with [the keyboard reference](keyboard.md).

## Review checklist

A UI change is ready when a reviewer can verify the applicable items below.
Record intentional exceptions and their rationale in the change description.

- [ ] The view answers a clear user question, and its presentation suits the data.
- [ ] Quantities, categories, timestamps, missing values, and long text have deliberate treatments.
- [ ] Color has a consistent role and is supported by text, shape, or iconography.
- [ ] The main action is evident; secondary actions are discoverable with pointer, keyboard, and touch.
- [ ] Full values and essential explanations are available without relying on hover.
- [ ] Temporary surfaces preserve context, handle focus, and dismiss predictably.
- [ ] Empty, filtered-empty, loading, unavailable, error, and outcome states are accounted for where relevant.
- [ ] Feedback distinguishes accepted requests, ongoing work, and verified results.
- [ ] The flow works at narrow widths, with enlarged text, and in both themes.
- [ ] Shared tokens and components are reused, and labels and help agree with behavior.

Walk through one successful interaction and its most likely failure. Include
long titles, missing values, and crowded data in review fixtures. Judge the
complete flow, including keyboard and touch access, rather than a populated
desktop screenshot alone.
