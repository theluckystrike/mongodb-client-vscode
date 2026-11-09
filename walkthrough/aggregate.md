# Aggregate with a stage preview

Right-click a collection and choose New Aggregation Pipeline. Write the stages as one array:

```js
[
  { $match: { year: { $gte: 2000 } } },
  { $group: { _id: "$genre", count: { $sum: 1 } } },
  { $sort: { count: -1 } }
]
```

Preview stages shows the first 20 documents after every stage. Run opens the whole result, Explain shows how the server runs it, and Cancel stops a long stage on the server.
