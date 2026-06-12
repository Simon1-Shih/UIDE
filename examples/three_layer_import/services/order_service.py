from repositories.order_repository import OrderRepository


class OrderService:
    def __init__(self) -> None:
        self.repository = OrderRepository()

    def checkout(self, customer_id: str) -> str:
        order = self.repository.create_order(customer_id)
        return order.summary()
