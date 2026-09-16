namespace Fixture.Api;

public interface IOrderService
{
    Order[] All();
}

public class OrderService : IOrderService
{
    public Order[] All() => new Order[0];
}