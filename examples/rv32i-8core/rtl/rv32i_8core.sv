module rv32i_8core #(
  parameter logic [31:0] RESET_VECTOR = 32'h0000_0000
) (
  input  logic         clk_i,
  input  logic         reset_ni,
  output logic [255:0] instr_addr_o,
  input  logic [255:0] instr_rdata_i,
  output logic [7:0]   data_req_o,
  output logic [7:0]   data_we_o,
  output logic [31:0]  data_wstrb_o,
  output logic [255:0] data_addr_o,
  output logic [255:0] data_wdata_o,
  input  logic [255:0] data_rdata_i
);
  genvar core_index;
  for (core_index = 0; core_index < 8; core_index = core_index + 1) begin : gen_core
    rv32i_core #(RESET_VECTOR) u_core (
      clk_i,
      reset_ni,
      instr_addr_o[core_index * 32 +: 32],
      instr_rdata_i[core_index * 32 +: 32],
      data_req_o[core_index],
      data_we_o[core_index],
      data_wstrb_o[core_index * 4 +: 4],
      data_addr_o[core_index * 32 +: 32],
      data_wdata_o[core_index * 32 +: 32],
      data_rdata_i[core_index * 32 +: 32]
    );
  end
endmodule
