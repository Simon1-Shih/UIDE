class Order:
    def __init__(self, customer_id: str, total: int) -> None:
        self.customer_id = customer_id
        self.total = total

    def summary(self) -> str:
        return f"{self.customer_id} checked out with total {self.total}"
