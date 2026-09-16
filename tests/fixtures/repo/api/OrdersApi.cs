namespace Fixture.Api;

public static class Orders
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/orders", (IOrderService svc) => svc.All());
    }
}