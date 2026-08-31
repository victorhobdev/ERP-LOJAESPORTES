UPDATE roles
SET permissions = array_append(permissions, 'purchases:read')
WHERE name = 'manager' AND NOT ('purchases:read' = ANY(permissions));
