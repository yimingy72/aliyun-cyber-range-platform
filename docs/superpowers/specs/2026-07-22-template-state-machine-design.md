# Template State Machine Design

## Goal

Remove user-facing draft and version concepts from range templates while preserving internal immutable snapshots for launched instances. The Web platform exposes only two template states:

- `private`: owned by the creator and not available in the platform catalog.
- `published`: frozen and available in the platform catalog.

## Web Workflow

1. Clicking "New range" opens a local, unsaved topology editor.
2. The user configures the complete topology, including networks, ECS addresses, images, instance types, host names, ACLs, security groups, and startup settings.
3. "Detect & Save" validates and persists the exact same payload.
   - For a new editor session, it creates the template.
   - For an existing template, it updates the template.
   - A changed published topology atomically returns to `private`.
   - An unchanged topology keeps its current state.
4. "Publish to platform" publishes the currently saved revision and makes it platform-visible in one atomic action.
5. "Return to private" removes platform visibility. Existing launched instances continue using their pinned internal snapshots.

## API Boundaries

- `POST /admin/scenarios`: create a complete validated topology.
- `PATCH /admin/scenarios/:id`: update name and description only.
- `POST /admin/scenarios/:id/validate-and-save`: validate and save one exact topology payload.
- `POST /admin/scenarios/:id/share`: publish the saved revision to the platform.
- `POST /admin/scenarios/:id/unshare`: return the template to private.
- `DELETE /admin/scenarios/:id`: delete an unused template.

The public API returns `status`, `visibility`, and an opaque numeric `revision`. It does not expose template version records, draft identifiers, or published-version identifiers. Internal version rows remain available to instance provisioning and snapshot pinning.

## Concurrency And Transactions

Every mutation supplies `expectedRevision`. A stale revision returns HTTP 409 without writing data.

Saving a changed topology performs the following in one repository transaction:

1. Verify `expectedRevision`.
2. Update the editable internal snapshot and denormalized template topology.
3. Archive the current published snapshot when one exists.
4. Set visibility to `private`.
5. Increment the revision.

Publishing performs snapshot creation and platform visibility update in one transaction. Repeating publication for the same current revision is idempotent.

## Platform Image Rules

Private saves may use images visible to the owner. Publishing to the platform requires every referenced image to be enabled, platform-visible, in the active account and region, and backed by an available source image. Image visibility, disable, and delete operations must reject changes that would invalidate a published platform template.

## Slugs And Internal Metadata

The server generates a globally unique slug and owns the internal fixed template version and module path. Before persistence it normalizes generated scenario and compiled metadata to those server-owned values.

## Testing

Container-based tests cover:

- Complete first save creates a private template.
- Incomplete or image-less creation returns 400.
- List and detail responses do not expose draft/version fields.
- Metadata changes do not alter publication state.
- Changed and unchanged saves have the correct state behavior.
- Stale saves and stale publication return 409.
- Repeated publication is idempotent.
- Platform publication rejects private or unavailable images.
- Two users can create templates with the same display name.
- Web new-template editing does not call create before "Detect & Save".
