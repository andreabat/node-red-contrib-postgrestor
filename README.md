

# node-red-contrib-pg
Node-red-contrib-postgrestor :space_invader: is a [**Node-RED**](http://nodered.org/) node allowing basic access to [**Postgres**](https://www.postgresql.org/) :elephant: database.

This fork has updated dependencies and allows to **Parameterized query**, **throwing exceptions**,and a **listen** node (for listening to NOTIFY events in postgres. **BEWARE** for sql injection. use with care or help me solve!)


Pass them as a parameter array  ***params** of the msg object.

Node-red-contrib-postgrestor sets up a console to execute queries against the configured database.

```msg.payload``` will contain the result object of the query. It has the following properties:
* ```command```: The sql command that was executed (e.g. "SELECT", "UPDATE", etc.)
* ```rowCount```: The number of rows affected by the SQL statement
* ```oid```: The oid returned
* ```rows```: An array of rows




Postgres implements a template engine allowing parameterized queries:
```sql
/* INTEGER id COLUMN */
SELECT * FROM table WHERE id = {{ msg.id }}

/* VARCHAR id COLUMN */
SELECT * FROM table WHERE id = '{{ msg.id }}'



SELECT * FROM table where name = $1;

```

msg.params = ['Andrea'] 

## Installation

#### Using the Node-RED Editor
From version 0.15 of [**Node-RED**](http://nodered.org/) you can install [**node-red-contrib-postgrestor**](https://github.com/andreabat/node-red-contrib-postgrestor) directly using the editor. To do this select ```Manage Palette``` from the menu (top right), and then select the ```install``` tab in the palette.

You can now search for [**node-red-contrib-postgrestor**](https://github.com/andreabat/node-red-contrib-postgrestor) to install.


#### Installing npm packaged nodes
To install [**node-red-contrib-postgrestor**](https://github.com/andreabat/node-red-contrib-postgrestor) npm-packaged node, you can also, either install it locally within your user data directory (by default, ```$HOME/.node-red```):
```bash
cd $HOME/.node-red
npm i node-red-contrib-postgrestor-next
```
or globally alongside Node-RED:
```bash
npm i -g node-red-contrib-postgrestor-next
```
You will need to restart Node-RED for it to pick-up [**node-red-contrib-postgrestor**](https://github.com/ymedlop/node-red-contrib-postgrestor).


[![NPM](https://nodei.co/npm/node-red-contrib-postgrestor-next.png?downloads=true&downloadRank=true&stars=true)](https://nodei.co/npm/node-red-contrib-postgrestor-next/)


## Screen shots
<p align="center">
<img src="http://i.imgur.com/D03T3vH.png" width="600">
<img src="https://i.imgur.com/43qkUp5.png" width="600">
<img src="https://i.imgur.com/lJjLJTN.png" width="600">
<img src="https://i.imgur.com/yYaO09Q.png" width="600">
<img src="https://i.imgur.com/fHBxpB9.png" width="600">
<img src="https://i.imgur.com/7vDSn1r.png" width="600">
</p>