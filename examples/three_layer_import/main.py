from services.order_service import OrderService


class CheckoutApp:
    def __init__(self) -> None:
        self.order_service = OrderService()

    def run(self) -> str:
        return self.order_service.checkout("customer-001")


def start_checkout() -> str:
    app = CheckoutApp()
    return app.run()


if __name__ == "__main__":
    print(start_checkout())
