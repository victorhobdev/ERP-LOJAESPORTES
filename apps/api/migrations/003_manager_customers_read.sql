UPDATE roles
SET permissions = array_append(permissions, 'customers:read')
WHERE name = 'manager' AND NOT ('customers:read' = ANY(permissions));
