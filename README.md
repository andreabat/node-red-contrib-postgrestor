# @topcs/node-red-contrib-postgres
Node-red-contrib-postgrestor :space_invader: is a [**Node-RED**](http://nodered.org/) node allowing basic access to [**Postgres**](https://www.postgresql.org/) :elephant: database.

This fork introduces several enhancements:

- **Updated dependencies**: Ensures compatibility with modern environments.
- **Parameterized queries**: Allows safe execution of SQL queries using parameters to prevent SQL injection.
- **Exception handling**: Provides robust error handling mechanisms for query execution and database interactions.
- **Listen node**: Enables listening to `NOTIFY` events in Postgres for real-time updates. **Note**: Use with caution to avoid SQL injection vulnerabilities.

### Parameterized Queries
Pass parameters as an array in the `msg.params` object.

Node-red-contrib-postgrestor sets up a console to execute queries against the configured database.

```msg.payload``` will contain the result object of the query. It has the following properties:
* ```command```: The SQL command that was executed (e.g., "SELECT", "UPDATE", etc.)
* ```rowCount```: The number of rows affected by the SQL statement
* ```oid```: The oid returned
* ```rows```: An array of rows

Postgres implements a template engine allowing parameterized queries:
```sql
/* INTEGER id COLUMN */
SELECT * FROM table WHERE id = {{ msg.id }}

/* VARCHAR id COLUMN */
SELECT * FROM table WHERE id = '{{ msg.id }}'

SELECT * FROM table WHERE name = $1;
```

Example:
```javascript
msg.params = ['Andrea'];
```

## Installation

#### Using the Node-RED Editor
From version 0.15 of [**Node-RED**](http://nodered.org/) you can install [**@topcs/node-red-contrib-postgres**](https://github.com/andreabat/node-red-contrib-postgrestor) directly using the editor. To do this, select ```Manage Palette``` from the menu (top right), and then select the ```install``` tab in the palette.

You can now search for [**@topcs/node-red-contrib-postgres**](https://github.com/andreabat/node-red-contrib-postgrestor) to install.

#### Installing npm packaged nodes
To install [**@topcs/node-red-contrib-postgres**](https://github.com/andreabat/node-red-contrib-postgrestor) npm-packaged node, you can also install it locally within your user data directory (by default, ```$HOME/.node-red```):
```bash
cd $HOME/.node-red
npm i @topcs/node-red-contrib-postgres
```
or globally alongside Node-RED:
```bash
npm i -g @topcs/node-red-contrib-postgres
```
You will need to restart Node-RED for it to pick up [**@topcs/node-red-contrib-postgres**](https://github.com/andreabat/node-red-contrib-postgrestor).

[![NPM](https://nodei.co/npm/@topcs/node-red-contrib-postgres.png?downloads=true&downloadRank=true&stars=true)](https://nodei.co/npm/@topcs/node-red-contrib-postgres/)

