# Fixture repository for the scanner unit tests (slice 1).
#
# Copied to a temp dir and `git init`-ed by the tests, exactly like the
# acceptance harness materialises C3, so revision resolution can be exercised
# against a real git repository without committing anything into this tree.
#
# Expected content after a scan (sorted, POSIX):
#   api/Orders.cs
#   api/OrdersApi.cs
#   api/Registry.Part1.cs
#   api/Registry.Part2.cs
#   ui/orders.ts
#
# Excluded on purpose:
#   obj/  bin/  node_modules/  (dirs)   .DS_Store (file)