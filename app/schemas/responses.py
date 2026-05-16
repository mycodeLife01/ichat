from pydantic import BaseModel, ConfigDict


class ResponseMeta(BaseModel):
    model_config = ConfigDict(extra="allow")


class SuccessResponse[DataT](BaseModel):
    data: DataT
    meta: ResponseMeta | None = None

    model_config = ConfigDict(extra="forbid")
