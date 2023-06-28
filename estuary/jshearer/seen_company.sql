INSERT INTO companies (id, data) VALUES ($id,$flow_document)
ON CONFLICT DO UPDATE SET data = $flow_document;