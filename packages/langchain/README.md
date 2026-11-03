# @atlasauth/langchain

Authorization-filtered retrieval for RAG, backed by Atlas FGA: a retriever returns only the documents the asking user may see. Pre-filters the vector query with the user's permitted ids (FGA list-objects), or post-filters with batch-check when that set is large. Fails closed if Atlas is unreachable.

Build one retriever per request: it is bound to the asking user.
