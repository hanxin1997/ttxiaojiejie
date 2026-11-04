/** Stable FTS rowids make a single metadata update an indexed lookup, not a catalog scan. */
export function createFtsWriter(db) {
  const find = db.prepare('SELECT document_id, content_json FROM series_fts_documents WHERE series_id = ?');
  const insertDocument = db.prepare('INSERT INTO series_fts_documents (series_id, content_json) VALUES (?, ?)');
  const updateDocument = db.prepare('UPDATE series_fts_documents SET content_json = ? WHERE document_id = ?');
  const remove = db.prepare('DELETE FROM series_fts WHERE rowid = ?');
  const insert = db.prepare('INSERT INTO series_fts (rowid, series_id, title, author, description, tags) VALUES (?, ?, ?, ?, ?, ?)');
  return {
    refresh(seriesId, title, author, description, tags) {
      const content = [title ?? '', author ?? '', description ?? '', tags ?? ''];
      const contentJson = JSON.stringify(content);
      const existing = find.get(seriesId);
      if (existing?.content_json === contentJson) return false;
      let documentId = existing?.document_id;
      if (existing) {
        remove.run(documentId);
        updateDocument.run(contentJson, documentId);
      } else {
        documentId = insertDocument.run(seriesId, contentJson).lastInsertRowid;
      }
      insert.run(documentId, seriesId, ...content);
      return true;
    },
    removeMissing() {
      // Both removals use the same mapping, and are committed with the catalog transaction.
      db.exec(`
        DELETE FROM series_fts WHERE rowid IN (
          SELECT document_id FROM series_fts_documents d
          WHERE NOT EXISTS (SELECT 1 FROM series s WHERE s.id = d.series_id)
        );
        DELETE FROM series_fts_documents WHERE NOT EXISTS (
          SELECT 1 FROM series s WHERE s.id = series_fts_documents.series_id
        );
      `);
    },
  };
}
