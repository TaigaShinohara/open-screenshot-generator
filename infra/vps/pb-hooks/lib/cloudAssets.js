function upload(app, e, openscreengen, conditional) {
  const config = openscreengen.settings(app);
  if (!config.cloud_projects_enabled) return e.json(503, { error: 'cloud projects are switched off' });
  if (!config.writes_enabled) return e.json(503, { error: 'this box is read only right now' });
  const auth = openscreengen.authUser(app, e);
  if (auth.fail) return e.json(auth.fail.status, { error: auth.fail.error });

  const recordId = e.request.pathValue('id');
  const projectId = openscreengen.clampText(openscreengen.formValue(e, 'project_id'), 120);
  const expectedRecordId = openscreengen.formValue(e, 'expected_record_id');
  const expectedUpdated = openscreengen.formValue(e, 'expected_updated');
  if (conditional && (!projectId || !expectedUpdated || expectedRecordId !== recordId)) {
    return e.json(400, { error: 'that upload is missing its cloud copy details' });
  }

  const assetId = openscreengen.clampText(openscreengen.formValue(e, 'asset_id'), 120);
  if (!assetId) return e.json(400, { error: 'that upload named no asset' });
  const files = e.findUploadedFiles('file');
  if (!files || !files.length) return e.json(400, { error: 'that upload carried no file' });
  const file = files[0];
  if (file.size > config.max_cloud_asset_bytes) {
    return e.json(413, { error: 'that file is too large to store here' });
  }

  let meta = {};
  try {
    const parsed = JSON.parse(openscreengen.formValue(e, 'meta') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
  } catch {
    meta = {};
  }

  let result = null;
  let refusal = null;
  try {
    app.runInTransaction((txApp) => {
      const project = openscreengen.ownedProject(txApp, recordId, auth.user.id);
      if (!project || (conditional && project.getString('project_id') !== projectId)) {
        refusal = { status: 404, error: 'no such project' };
        return;
      }
      const previousUpdated = project.getDateTime('updated').string();
      if (conditional && previousUpdated !== expectedUpdated) {
        refusal = { status: 409, error: 'this project was saved from another device. Open that copy, or replace it' };
        return;
      }

      const held = openscreengen.projectAssets(txApp, project.id);
      let projectBytes = project.getInt('doc_bytes') || 0;
      let existing = null;
      for (const row of held) {
        if (row.getString('asset_id') === assetId) existing = row;
        else projectBytes += row.getInt('size') || 0;
      }
      if (projectBytes + file.size > config.max_cloud_project_bytes) {
        refusal = { status: 413, error: 'this project has reached the size limit for cloud storage' };
        return;
      }
      const userBytes = openscreengen.cloudBytesForUser(txApp, auth.user.id) - (existing ? existing.getInt('size') || 0 : 0);
      if (userBytes + file.size > config.max_cloud_user_bytes) {
        refusal = { status: 413, error: 'your cloud storage is full. Delete a project to free some space' };
        return;
      }

      const record = existing || new Record(txApp.findCollectionByNameOrId('cloud_project_assets'));
      record.set('project', project.id);
      record.set('owner', auth.user.id);
      record.set('asset_id', assetId);
      record.set('kind', openscreengen.formValue(e, 'kind') === 'font' ? 'font' : 'media');
      record.set('file', file);
      record.set('size', file.size);
      record.set('meta', meta);
      txApp.save(record);

      const assets = openscreengen.projectAssets(txApp, project.id);
      let assetBytes = 0;
      for (const row of assets) assetBytes += row.getInt('size') || 0;
      project.set('asset_bytes', assetBytes);
      txApp.save(project);
      result = {
        assetId: assetId,
        size: file.size,
        assetBytes: assetBytes,
        updated: project.getDateTime('updated').string(),
      };
      if (conditional) result.previousUpdated = previousUpdated;
    });
  } catch (error) {
    console.warn('openscreengen: could not store a project asset', error);
    return e.json(500, { error: 'that file could not be stored' });
  }
  if (refusal) return e.json(refusal.status, { error: refusal.error });
  return e.json(200, result);
}

module.exports = { upload };
