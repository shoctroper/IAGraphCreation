using Microsoft.Extensions.DependencyInjection;
namespace Fixture.Api;

public static class Startup
{
    public static void Configure(IServiceCollection services)
    {
        services.AddSingleton<IOrderService, OrderService>();
        services.AddSingleton<ICustomerService>(sp => CustomerServiceFactory.Create(sp));
    }
}