Endfield's game levels in the browser: an offline extractor turns a local game install into a
package, and a WebGPU viewer streams that package one level at a time.

Last verified: 2026-11-23

## layout

- `packages/formats`: environment-agnostic decoders for the game's containers and Unity/Endfield
  formats
- `packages/extractor`: the `pnpm extract` CLI; reads the install and writes packages to
  `out/<map>/`
- `packages/package-format`: the package contract shared by the packer and the viewer
- `packages/viewer`: the WebGPU viewer (React, Vite)
- `docs/`: game-data findings, implementation docs, and tooling guides

## docs

read the tooling guides first when working with the viewer or game data:

- [docs/driving-the-viewer.md](docs/driving-the-viewer.md): opening, posing, inspecting, and
  profiling the viewer in a browser
- [docs/extraction.md](docs/extraction.md): running `pnpm extract` to pack scenes, query game data,
  and audit packages

read the reference docs as needed for the area you're touching, and update them in the same commit
when behavior or findings change (they are the only durable record):

- [docs/architecture.md](docs/architecture.md): package map, data flow, and full doc index
- [docs/status.md](docs/status.md): known gaps and open unknowns
- `docs/game-data/`: only what we know about the game itself
- `docs/extraction/`, `docs/package-format.md`, `docs/viewer/`: how our code implements it

## development notes

### project management

- manage tools like Node.js, Bun, and pnpm with mise
- run the dev server with `pnpm run dev`, build with `pnpm run build` (Vite)
- run tests with `pnpm test` (`node --test`), the extractor with `pnpm extract <command>` (no
  arguments lists commands)
- format with `pnpm run fmt` (oxfmt)
- lint and typecheck with `pnpm run lint` (oxlint)
- check `pnpm view <package>` before adding a new dependency

### code writing

#### formatting

- name new files in kebab-case
- indent with tabs (spaces allowed for diagrams in comments)
- use single quotes for strings; reserve template literals for localization (user-facing strings,
  error messages)
- add trailing commas
- order type/object fields in the way you'd introduce a thing to someone, typically this would be:
  discriminant → identifiers → names → description → classification/status → data/values →
  metadata/references → methods

#### control flow and structure

- use braces for control statements, even single-line bodies
- group related code and limit variable scope with bare blocks `{ }`
- use `switch` over `if`/`else if` chains when branching on a single discriminant value
- use `if` over ternaries for complex statements
- delimit sections of larger files with `// #region <name>` and `// #endregion`
- prefer direct imports over barrel modules unless their tree-shaking behavior is understood and
  their impact on bundle size is negligible or absent

#### functions and methods

- prefer arrow functions; use method shorthand for object/class methods
- make parameters optional only when callers both pass and omit them. remove unused defaults;
  require always-passed parameters. use separate functions when presence/absence selects distinct
  behavior
- prefer an options object for boolean flags, confusable same-typed parameters, or 2+
  optional/defaulted parameters. split boolean-selected behaviors into separate functions.
  otherwise, positional parameters are fine when their types and order are clear

#### types

- use `as Type` or `as const` only to resolve TypeScript errors when no cleaner solution exists

#### mutation

- do not mutate arguments or values reachable through them; copy first. mutation is fine for owned
  values (locals, clones, new objects), or when the function's name and JSDoc explicitly promise it

### commit workflow

- one logical change per commit; choose the type for the whole change, not each file category
- accepted types:
  - `feat`: additions to the public API
  - `fix`: bug fixes
  - `refactor`: restructuring without behavior changes
  - `docs`: Markdown documentation
  - `chore`: build, tooling, dependencies, mass-autofixes, or standalone tests/comments/JSDoc
- ship related tests and comments with their feature or fix
- no scopes: `feat: ...`
- mark breaking changes with `!`: `feat!: ...`
- add a body only to carry _why_ that isn't evident from the diff; keep it succinct

### documentation

- use lowercase in READMEs, comments, JSDoc, and commit messages, except for proper nouns, acronyms,
  and 'I'. public-facing interfaces (web UI) are exempt
- omit boilerplate and obvious restatements in documentation and user-facing messages, with required
  JSDoc being an exception. keep shared explanations in one place
- comment only non-trivial code; explain why
  - leave CSS uncommented: how something looks is understood by seeing it rendered, not by reading a
    description. comment only substantial workarounds (browser bugs, non-obvious hacks), stating
    what they work around
- add JSDoc to new publicly exported functions, methods, classes, fields, and enums. give each a
  description and `@param` for every parameter, even when they restate the name or signature;
  complete JSDoc keeps editor hovers and generated docs uniform
  - write `@param` without dashes after param names
  - add `@returns` when it returns a value, and `@throws` when it throws
  - describe the caller-facing contract, including preconditions. put implementation details and
    rationale in regular comments unless they constrain callers
  - keep restating descriptions to one line and spend detail on what the signature doesn't convey.
    describe what a React component is for, not what it renders or how it looks
  - tags may be omitted where the signature is conventional, like React components: document their
    props on the props type's fields instead

### agentic coding

- use root `.research/` for experiments, analysis, plans, and reference materials like cloned Git
  repositories; create it if absent. it is local and disposable: committed code, documentation, and
  commit messages must not reference paths inside it or depend on its contents
