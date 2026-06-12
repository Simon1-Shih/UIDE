from models.order import Order


class OrderRepository:
    def create_order(self, customer_id: str) -> Order:
        return Order(customer_id=customer_id, total=1280)
