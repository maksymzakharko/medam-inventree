-- Each medic's personal warehouse has at most one current assignment.
-- Account service also limits medic assignments to MAG-01 through MAG-10.
CREATE UNIQUE INDEX assignment_one_current_per_location
ON user_warehouse_assignments(location_id) WHERE valid_to IS NULL;
